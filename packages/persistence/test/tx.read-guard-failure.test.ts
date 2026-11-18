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

/** Arms a deterministic failure for the given read-guard stage only. */
function failOn(stage: 'enable' | 'restore', message = 'simulated guard failure'): void {
  setReadGuardFaultForTests((current) => (current === stage ? new Error(message) : null));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

function queryOnly(store: ReturnType<typeof openMigratedStore>): number {
  const row = allRows<{ query_only: number }>(databaseOf(store).prepare('PRAGMA query_only'))[0];
  return row?.query_only ?? -1;
}

function countPersonas(store: ReturnType<typeof openMigratedStore>): number {
  const row = allRows<{ n: number }>(
    databaseOf(store).prepare('SELECT count(*) AS n FROM personas'),
  )[0];
  return row?.n ?? -1;
}

describe('standalone read scope — cleanup failure', () => {
  it('fails the call when the body succeeded but the guard could not be restored', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_seed', 'Seed', 'CREATED', NOW, NOW);
    });

    failOn('restore');

    let caught: unknown;
    let returned = false;
    try {
      withRead(store, (tx) => {
        expect(allRows<{ n: number }>(tx.prepare('SELECT count(*) AS n FROM personas'))[0]?.n).toBe(
          1,
        );
        return 'would-be-success';
      });
      returned = true;
    } catch (error) {
      caught = error;
    }

    expect(returned).toBe(false);
    expect((caught as PersistenceError).code).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);

    // Data is untouched: a read scope never wrote anything.
    expect(countPersonas(store)).toBe(1);

    // And the store refuses further work.
    expect(codeOf(() => withRead(store, () => 1))).toBe('store_unusable');
    expect(codeOf(() => withWrite(store, () => 1))).toBe('store_unusable');
  });

  it('keeps the callback error when both the body and the cleanup fail', () => {
    const store = openMigratedStore();
    const original = new Error('callback exploded');

    failOn('restore');

    let caught: unknown;
    try {
      withRead(store, () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(isStoreUnusable(store)).toBe(true);

    // The cleanup failure survives as the recorded reason on later rejections.
    let rejection: PersistenceError | undefined;
    try {
      withRead(store, () => 1);
    } catch (error) {
      rejection = error as PersistenceError;
    }

    expect(rejection?.code).toBe('store_unusable');
    const reason = rejection?.cause as Error | undefined;
    expect(reason?.message).toContain('restore the read-only guard');
    expect(reason?.message).not.toContain('SELECT');
  });
});

describe('nested read scope — cleanup failure', () => {
  it('fails the whole operation when the nested body succeeded', () => {
    const store = openMigratedStore();
    failOn('restore');

    let caught: unknown;
    try {
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

        const seen = withRead(store, (readTx) =>
          allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas')),
        );
        expect(seen[0]?.n).toBe(1);

        tx.prepare(INSERT_PERSONA).run('psn_second', 'Second', 'CREATED', NOW, NOW);
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as PersistenceError).code).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);
    // The outer transaction never completed, so nothing was committed.
    expect(countPersonas(store)).toBe(0);
    expect(codeOf(() => withWrite(store, () => 1))).toBe('store_unusable');
  });

  it('keeps the callback error when the nested body and cleanup both fail', () => {
    const store = openMigratedStore();
    const original = new Error('nested explosion');

    failOn('restore');

    let caught: unknown;
    try {
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);
        withRead(store, () => {
          throw original;
        });
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(isStoreUnusable(store)).toBe(true);
    expect(countPersonas(store)).toBe(0);
  });
});

describe('read guard failures refuse further transactions', () => {
  it('rejects withRead and withWrite after an enable failure', () => {
    const store = openMigratedStore();
    failOn('enable');

    expect(codeOf(() => withRead(store, () => 1))).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);

    failOn('enable');
    expect(codeOf(() => withRead(store, () => 1))).toBe('store_unusable');
    expect(codeOf(() => withWrite(store, () => 1))).toBe('store_unusable');
  });
});

describe('the normal path is unchanged', () => {
  it('restores query_only and keeps working', () => {
    const store = openMigratedStore();

    const value = withRead(store, (tx) =>
      allRows<{ n: number }>(tx.prepare('SELECT count(*) AS n FROM personas')),
    );
    expect(value[0]?.n).toBe(0);
    expect(queryOnly(store)).toBe(0);
    expect(isStoreUnusable(store)).toBe(false);

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_after', 'After', 'CREATED', NOW, NOW);
    });
    expect(countPersonas(store)).toBe(1);
    expect(queryOnly(store)).toBe(0);
    expect(isStoreUnusable(store)).toBe(false);
  });

  it('a nested read still sees uncommitted rows and restores the guard', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      const seen = withRead(store, (readTx) => {
        expect(queryOnly(store)).toBe(1);
        return allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas'))[0]?.n;
      });

      expect(seen).toBe(1);
      expect(queryOnly(store)).toBe(0);
      tx.prepare(INSERT_PERSONA).run('psn_legal', 'Legal', 'CREATED', NOW, NOW);
    });

    expect(countPersonas(store)).toBe(2);
    expect(isStoreUnusable(store)).toBe(false);
  });
});
