import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { withWrite, type Tx } from '../src/index.js';
import { closeAll, countRows, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const INSERT_PERSONA =
  'INSERT INTO personas (id, display_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

type Prepared = ReturnType<Tx['prepare']>;

describe('withWrite — commit and rollback', () => {
  it('commits when the callback returns normally', () => {
    const store = openMigratedStore();

    const result = withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(countRows(store, 'personas')).toBe(1);
  });

  it('rolls back every statement when the callback throws', () => {
    const store = openMigratedStore();

    expect(() =>
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
        tx.prepare(INSERT_PERSONA).run('psn_2', 'Second', 'CREATED', NOW, NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(countRows(store, 'personas')).toBe(0);
  });

  it('rethrows the original application error unchanged', () => {
    const store = openMigratedStore();
    const original = new Error('application failure');
    original.name = 'ApplicationError';

    let caught: unknown;
    try {
      withWrite(store, () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect((caught as Error).name).toBe('ApplicationError');
  });

  it('is usable again after a failed transaction', () => {
    const store = openMigratedStore();

    expect(() =>
      withWrite(store, () => {
        throw new Error('first attempt fails');
      }),
    ).toThrow();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    expect(countRows(store, 'personas')).toBe(1);
  });
});

describe('withWrite — nesting is refused, not silently opened', () => {
  it('rejects a nested write transaction', () => {
    const store = openMigratedStore();

    expect(codeOf(() => withWrite(store, () => withWrite(store, () => 1)))).toBe('nested_write');
    expect(countRows(store, 'personas')).toBe(0);
  });

  it('lets the outer transaction continue when the inner error is caught', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);
      expect(codeOf(() => withWrite(store, () => 1))).toBe('nested_write');
    });

    expect(countRows(store, 'personas')).toBe(1);
  });
});

describe('withWrite — callback must be synchronous', () => {
  it('rejects an async callback and rolls back', () => {
    const store = openMigratedStore();

    const run = () =>
      withWrite(store, async () => {
        return 1;
      });

    expect(codeOf(run)).toBe('async_callback_unsupported');
    expect(countRows(store, 'personas')).toBe(0);
  });

  it('rejects a callback that returns a thenable by hand', () => {
    const store = openMigratedStore();

    const thenable = { then: () => undefined };
    expect(codeOf(() => withWrite(store, () => thenable as unknown as number))).toBe(
      'async_callback_unsupported',
    );
  });
});

describe('withWrite — the handle cannot outlive the transaction', () => {
  it('rejects a statement captured inside the callback', () => {
    const store = openMigratedStore();
    let captured: Prepared | undefined;

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
      captured = tx.prepare(INSERT_PERSONA);
    });

    const statement = captured as NonNullable<Prepared>;
    expect(codeOf(() => statement.run('psn_2', 'x', 'CREATED', NOW, NOW))).toBe(
      'transaction_closed',
    );
    expect(countRows(store, 'personas')).toBe(1);
  });

  it('rejects a statement captured in a transaction that rolled back', () => {
    const store = openMigratedStore();
    let captured: Prepared | undefined;

    expect(() =>
      withWrite(store, (tx) => {
        captured = tx.prepare(INSERT_PERSONA);
        throw new Error('abort');
      }),
    ).toThrow('abort');

    const statement = captured as NonNullable<Prepared>;
    expect(codeOf(() => statement.run('psn_9', 'x', 'CREATED', NOW, NOW))).toBe(
      'transaction_closed',
    );
    expect(countRows(store, 'personas')).toBe(0);
  });

  it('rejects an iterator consumed after the transaction ended', () => {
    const store = openMigratedStore();
    let capturedIterator: Iterator<unknown> | undefined;

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
      capturedIterator = tx.prepare('SELECT id FROM personas').iterate();
    });

    expect(capturedIterator).toBeDefined();
    expect(codeOf(() => (capturedIterator as Iterator<unknown>).next())).toBe('transaction_closed');
  });

  it('exposes no arbitrary SQL entry point on the transaction handle', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      expect('exec' in tx).toBe(false);
      expect(Object.keys(tx).sort()).toStrictEqual(['kind', 'prepare']);
    });
  });

  it('refuses to start a transaction on a closed store', () => {
    const store = openMigratedStore();
    store.close();

    expect(codeOf(() => withWrite(store, () => 1))).toBe('store_closed');
  });
});

describe('withWrite — concurrent callers do not interleave', () => {
  it('runs two scheduled writers one after the other', async () => {
    const store = openMigratedStore();
    const trace: string[] = [];

    const write = (id: string) => () =>
      withWrite(store, (tx) => {
        trace.push(`${id}:start`);
        tx.prepare(INSERT_PERSONA).run(id, id, 'CREATED', NOW, NOW);
        trace.push(`${id}:end`);
      });

    await Promise.all([
      Promise.resolve().then(write('psn_a')),
      Promise.resolve().then(write('psn_b')),
    ]);

    expect(trace).toStrictEqual(['psn_a:start', 'psn_a:end', 'psn_b:start', 'psn_b:end']);
    expect(countRows(store, 'personas')).toBe(2);
    // Connection is still healthy after both transactions.
    const probe = databaseOf(store).prepare('SELECT 1 AS ok').get() as { ok?: number } | undefined;
    expect(probe?.ok).toBe(1);
  });
});
