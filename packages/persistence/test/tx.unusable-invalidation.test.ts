import { afterEach, describe, expect, it } from 'vitest';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { isStoreUnusable, withRead, withWrite } from '../src/index.js';
import { setReadGuardFaultForTests } from '../src/tx/read-guard-fault.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(() => {
  setReadGuardFaultForTests(null);
  closeAll();
});

const INSERT_PERSONA =
  'INSERT INTO personas (id, display_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';

function failOnRestore(): void {
  setReadGuardFaultForTests((stage) =>
    stage === 'restore' ? new Error('simulated restore failure') : null,
  );
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

function personaIds(store: ReturnType<typeof openMigratedStore>): string[] {
  return allRows<{ id: string }>(
    databaseOf(store).prepare('SELECT id FROM personas ORDER BY id'),
  ).map((row) => row.id);
}

describe('a poisoned store invalidates the transaction that is running', () => {
  it('refuses further writes and never commits when the outer callback swallows the error', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_seed', 'Seed', 'CREATED', NOW, NOW);
    });

    failOnRestore();
    const observed: string[] = [];

    let caught: unknown;
    try {
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

        try {
          withRead(store, (readTx) =>
            allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas')),
          );
          observed.push('nested-returned');
        } catch (error) {
          observed.push(`nested-failed:${(error as PersistenceError).code}`);
        }

        try {
          tx.prepare(INSERT_PERSONA).run('psn_after', 'After', 'CREATED', NOW, NOW);
          observed.push('write-allowed');
        } catch (error) {
          observed.push(`write-failed:${(error as PersistenceError).code}`);
        }

        return 'callback-returned-normally';
      });
    } catch (error) {
      caught = error;
    }

    expect(observed).toStrictEqual(['nested-failed:store_unusable', 'write-failed:store_unusable']);
    expect((caught as PersistenceError).code).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);

    // Nothing from the outer transaction was committed; the earlier seed stays.
    expect(personaIds(store)).toStrictEqual(['psn_seed']);

    // Rollback really happened: no transaction is left dangling on the connection.
    // The simulated restore failure skips `query_only = OFF`, so the connection is
    // genuinely read-only here — probe with a read-only BEGIN and undo it.
    const db = databaseOf(store);
    expect(() => {
      db.exec('BEGIN DEFERRED');
      db.exec('ROLLBACK');
    }).not.toThrow();
    expect(allRows<{ query_only: number }>(db.prepare('PRAGMA query_only'))[0]?.query_only).toBe(1);
  });

  it('refuses to commit even when the callback returns without touching the store again', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_seed', 'Seed', 'CREATED', NOW, NOW);
    });

    failOnRestore();

    let caught: unknown;
    try {
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

        try {
          withRead(store, () => 1);
        } catch {
          // Swallowed on purpose: the coordinator must still refuse the commit.
        }

        return 'ignored';
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as PersistenceError).code).toBe('store_unusable');
    expect(personaIds(store)).toStrictEqual(['psn_seed']);
  });

  it('stops statements prepared before the failure from executing', () => {
    const store = openMigratedStore();
    failOnRestore();

    const codes: string[] = [];

    expect(() =>
      withWrite(store, (tx) => {
        const statement = tx.prepare(INSERT_PERSONA);

        try {
          withRead(store, () => 1);
        } catch {
          // Swallowed: the statement below must be dead anyway.
        }

        codes.push(codeOf(() => statement.run('psn_late', 'Late', 'CREATED', NOW, NOW)));
      }),
    ).toThrow();

    expect(codes).toStrictEqual(['transaction_closed']);
    expect(personaIds(store)).toStrictEqual([]);
    expect(isStoreUnusable(store)).toBe(true);
  });
});

describe('normal nested read/write behaviour is unchanged', () => {
  it('commits both the outer writes and the rows seen by the nested read', () => {
    const store = openMigratedStore();

    const seen = withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      const inside = withRead(store, (readTx) =>
        allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas')),
      )[0]?.n;

      tx.prepare(INSERT_PERSONA).run('psn_legal', 'Legal', 'CREATED', NOW, NOW);
      return inside;
    });

    expect(seen).toBe(1);
    expect(personaIds(store)).toStrictEqual(['psn_legal', 'psn_outer']);
    expect(isStoreUnusable(store)).toBe(false);
  });

  it('keeps working across repeated nested reads', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_a', 'A', 'CREATED', NOW, NOW);

      for (const expected of [1, 2, 3]) {
        const count = withRead(store, (readTx) =>
          allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas')),
        )[0]?.n;
        expect(count).toBe(expected);

        if (expected < 3) {
          tx.prepare(INSERT_PERSONA).run(`psn_${expected}`, 'X', 'CREATED', NOW, NOW);
        }
      }
    });

    expect(personaIds(store)).toStrictEqual(['psn_1', 'psn_2', 'psn_a']);
    expect(isStoreUnusable(store)).toBe(false);
  });
});
