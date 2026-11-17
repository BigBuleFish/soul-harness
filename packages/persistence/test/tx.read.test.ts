import { afterEach, describe, expect, it } from 'vitest';
import type { PersonaId } from '@soul-harness/contracts';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { createRepositories, withRead, withWrite } from '../src/index.js';
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

describe('withRead 鈥?reads inside the read transaction', () => {
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

describe('withRead 鈥?writes are rejected', () => {
  it('rejects a raw write with a read-only violation', () => {
    const store = openMigratedStore();

    const code = codeOf(() =>
      withRead(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
      }),
    );

    expect(code).toBe('read_only_violation');
    expect(countPersonas(store)).toBe(0);
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
  });
});

describe('withRead 鈥?scope hygiene', () => {
  it('restores write capability afterwards', () => {
    const store = openMigratedStore();

    expect(
      codeOf(() =>
        withRead(store, (tx) => {
          tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
        }),
      ),
    ).toBe('read_only_violation');

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
