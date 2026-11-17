import { afterEach, describe, expect, it } from 'vitest';
import type { PersonaId } from '@soul-harness/contracts';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { createRepositories, withRead, withWrite, type ReadTx } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

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

function countPersonas(store: ReturnType<typeof openMigratedStore>): number {
  const rows = allRows<{ n: number }>(
    databaseOf(store).prepare('SELECT count(*) AS n FROM personas'),
  );
  return rows[0]?.n ?? 0;
}

function queryOnlyFlag(store: ReturnType<typeof openMigratedStore>): number {
  const rows = allRows<{ query_only: number }>(databaseOf(store).prepare('PRAGMA query_only'));
  return rows[0]?.query_only ?? -1;
}

type Prepared = ReturnType<ReadTx['prepare']>;

describe('withRead — reads inside the read transaction', () => {
  it('can read', () => {
    const store = openMigratedStore();

    const rows = withRead(store, (tx) =>
      allRows<{ n: number }>(tx.prepare('SELECT count(*) AS n FROM personas')),
    );

    expect(rows[0]?.n).toBe(0);
  });

  it('allows a nested read', () => {
    const store = openMigratedStore();

    const rows = withRead(store, () =>
      withRead(store, (inner) =>
        allRows<{ n: number }>(inner.prepare('SELECT count(*) AS n FROM personas')),
      ),
    );

    expect(rows[0]?.n).toBe(0);
  });
});

describe('withRead — writes are rejected', () => {
  it('refuses to prepare an INSERT at all', () => {
    const store = openMigratedStore();

    const code = codeOf(() =>
      withRead(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
      }),
    );

    expect(code).toBe('statement_blocked');
    expect(countPersonas(store)).toBe(0);
  });

  it('still refuses a WITH-prefixed write at execution (query_only)', () => {
    const store = openMigratedStore();

    // `WITH` is an allowed leading keyword, so this passes the prepare gate and
    // must be stopped by the connection-level read-only flag instead.
    const code = codeOf(() =>
      withRead(store, (tx) => {
        tx.prepare(
          `WITH v(id, name) AS (VALUES ('psn_w', 'W'))
           INSERT INTO personas (id, display_name, state, created_at, updated_at)
           SELECT id, name, 'CREATED', ?, ? FROM v`,
        ).run(NOW, NOW);
      }),
    );

    expect(code).toBe('read_only_violation');
    expect(countPersonas(store)).toBe(0);
  });

  it('refuses to even prepare UPDATE and DELETE in a read scope', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    expect(
      codeOf(() =>
        withRead(store, (tx) => {
          tx.prepare('DELETE FROM personas');
        }),
      ),
    ).toBe('statement_blocked');

    expect(
      codeOf(() =>
        withRead(store, (tx) => {
          tx.prepare('UPDATE personas SET display_name = ?');
        }),
      ),
    ).toBe('statement_blocked');

    expect(countPersonas(store)).toBe(1);
  });

  it('rejects a repository write with nested_write', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);

    const code = codeOf(() =>
      withRead(store, () => {
        repos.personas.insert({
          id: 'psn_1' as PersonaId,
          displayName: 'Primary',
          state: 'CREATED',
          createdAt: NOW,
          updatedAt: NOW,
        });
      }),
    );

    expect(code).toBe('nested_write');
    expect(countPersonas(store)).toBe(0);
  });

  it('refuses to disable query_only from inside the read scope', () => {
    const store = openMigratedStore();

    const code = codeOf(() =>
      withRead(store, (tx) => {
        tx.prepare('PRAGMA query_only = OFF');
      }),
    );

    expect(code).toBe('statement_blocked');

    // The protection is restored after the scope, so writes work again.
    expect(queryOnlyFlag(store)).toBe(0);
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });
    expect(countPersonas(store)).toBe(1);
  });
});

describe('withRead — the handle cannot outlive the transaction', () => {
  it('rejects statements captured inside a finished read scope', () => {
    const store = openMigratedStore();
    let captured: Prepared | undefined;

    withRead(store, (tx) => {
      captured = tx.prepare('SELECT count(*) AS n FROM personas');
    });

    const statement = captured as NonNullable<Prepared>;
    expect(codeOf(() => statement.get())).toBe('transaction_closed');
    expect(codeOf(() => statement.all())).toBe('transaction_closed');
    expect(codeOf(() => statement.run())).toBe('transaction_closed');
  });

  it('rejects iterators consumed after the scope ended', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    let capturedIterator: Iterator<unknown> | undefined;
    withRead(store, (tx) => {
      // Created but not consumed: only `next()` can hit the guard.
      capturedIterator = tx.prepare('SELECT id FROM personas').iterate();
    });

    expect(capturedIterator).toBeDefined();
    expect(codeOf(() => (capturedIterator as Iterator<unknown>).next())).toBe('transaction_closed');
  });
});

describe('withRead — scope hygiene', () => {
  it('restores write capability afterwards', () => {
    const store = openMigratedStore();

    expect(
      codeOf(() =>
        withRead(store, (tx) => {
          tx.prepare('DELETE FROM personas');
        }),
      ),
    ).toBe('statement_blocked');

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_2', 'Second', 'CREATED', NOW, NOW);
    });

    expect(countPersonas(store)).toBe(1);
  });

  it('rethrows the original error and still restores write capability', () => {
    const store = openMigratedStore();
    const original = new Error('read failed');

    let caught: unknown;
    try {
      withRead(store, () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });
    expect(countPersonas(store)).toBe(1);
  });

  it('joins an outer write transaction and sees uncommitted rows', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);

      const seen = withRead(store, (readTx) =>
        allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas')),
      );
      expect(seen[0]?.n).toBe(1);
    });
  });

  it('refuses to read from a closed store', () => {
    const store = openMigratedStore();
    store.close();

    expect(codeOf(() => withRead(store, () => 1))).toBe('store_closed');
  });
});
