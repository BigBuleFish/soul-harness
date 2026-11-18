import { afterEach, describe, expect, it } from 'vitest';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { withRead, withWrite } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const INSERT_PERSONA =
  'INSERT INTO personas (id, display_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';

/** Write statements whose first keyword is WITH, so the read-surface gate lets them through. */
const WITH_INSERT = `WITH v(id, name) AS (VALUES ('psn_illegal', 'Illegal'))
  INSERT INTO personas (id, display_name, state, created_at, updated_at)
  SELECT id, name, 'CREATED', ?, ? FROM v`;

const WITH_UPDATE = `WITH v(id) AS (VALUES ('psn_outer'))
  UPDATE personas SET display_name = 'hijacked' WHERE id IN (SELECT id FROM v)`;

const WITH_DELETE = `WITH v(id) AS (VALUES ('psn_outer'))
  DELETE FROM personas WHERE id IN (SELECT id FROM v)`;

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

function personaIds(store: ReturnType<typeof openMigratedStore>): string[] {
  return allRows<{ id: string }>(
    databaseOf(store).prepare('SELECT id FROM personas ORDER BY id'),
  ).map((row) => row.id);
}

function displayNameOf(
  store: ReturnType<typeof openMigratedStore>,
  id: string,
): string | undefined {
  return allRows<{ display_name: string }>(
    databaseOf(store).prepare('SELECT display_name FROM personas WHERE id = ?'),
    id,
  )[0]?.display_name;
}

describe('nested read scope — reads still work', () => {
  it('sees rows the outer write transaction has not committed', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      const seen = withRead(store, (readTx) => {
        expect(queryOnly(store)).toBe(1);
        return allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas'))[0]?.n;
      });

      expect(seen).toBe(1);
      expect(queryOnly(store)).toBe(0);
    });

    expect(personaIds(store)).toStrictEqual(['psn_outer']);
  });
});

describe('nested read scope — writes are impossible', () => {
  it('blocks a direct INSERT at prepare time', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(
        codeOf(() =>
          withRead(store, (readTx) => {
            readTx.prepare(INSERT_PERSONA).run('psn_bad', 'Bad', 'CREATED', NOW, NOW);
          }),
        ),
      ).toBe('statement_blocked');

      expect(personaIds(store)).toStrictEqual(['psn_outer']);
    });
  });

  it('blocks WITH … INSERT at execution (query_only, not keyword matching)', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(
        codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_INSERT).run(NOW, NOW))),
      ).toBe('read_only_violation');

      expect(personaIds(store)).toStrictEqual(['psn_outer']);
    });
  });

  it('blocks WITH … UPDATE', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_UPDATE).run()))).toBe(
        'read_only_violation',
      );

      expect(displayNameOf(store, 'psn_outer')).toBe('Outer');
    });
  });

  it('blocks WITH … DELETE', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_DELETE).run()))).toBe(
        'read_only_violation',
      );

      expect(personaIds(store)).toStrictEqual(['psn_outer']);
    });
  });
});

describe('nested read scope — the outer write transaction keeps working', () => {
  it('continues writing after blocked attempts and commits only the legal rows', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(
        codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_INSERT).run(NOW, NOW))),
      ).toBe('read_only_violation');
      expect(codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_DELETE).run()))).toBe(
        'read_only_violation',
      );

      // The guard must be gone again, otherwise this insert would fail too.
      expect(queryOnly(store)).toBe(0);
      tx.prepare(INSERT_PERSONA).run('psn_legal', 'Legal', 'CREATED', NOW, NOW);
    });

    expect(personaIds(store)).toStrictEqual(['psn_legal', 'psn_outer']);
    expect(displayNameOf(store, 'psn_outer')).toBe('Outer');
  });

  it('restores the guard when the inner scope throws, and the outer can still write', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      expect(() =>
        withRead(store, () => {
          throw new Error('inner exploded');
        }),
      ).toThrow('inner exploded');

      expect(queryOnly(store)).toBe(0);
      tx.prepare(INSERT_PERSONA).run('psn_after', 'After', 'CREATED', NOW, NOW);
    });

    expect(personaIds(store)).toStrictEqual(['psn_after', 'psn_outer']);
  });
});

describe('nested read scope — rollback and connection state', () => {
  it('rolls the outer transaction back when the inner error escapes', () => {
    const store = openMigratedStore();
    const original = new Error('inner failure');

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
    expect(personaIds(store)).toStrictEqual([]);
    expect(queryOnly(store)).toBe(0);

    // Connection is still reliable for a fresh transaction.
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_retry', 'Retry', 'CREATED', NOW, NOW);
    });
    expect(personaIds(store)).toStrictEqual(['psn_retry']);
  });

  it('restores the guard across several consecutive nested scopes', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_outer', 'Outer', 'CREATED', NOW, NOW);

      for (let round = 0; round < 3; round += 1) {
        expect(
          codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_INSERT).run(NOW, NOW))),
        ).toBe('read_only_violation');
        expect(queryOnly(store)).toBe(0);

        expect(codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_DELETE).run()))).toBe(
          'read_only_violation',
        );
        expect(queryOnly(store)).toBe(0);
      }

      tx.prepare(INSERT_PERSONA).run('psn_legal', 'Legal', 'CREATED', NOW, NOW);
    });

    expect(personaIds(store)).toStrictEqual(['psn_legal', 'psn_outer']);
  });
});

describe('standalone read scope — existing behaviour is unchanged', () => {
  it('reads, refuses writes, and restores the connection', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_seed', 'Seed', 'CREATED', NOW, NOW);
    });

    const seen = withRead(store, (readTx) => {
      expect(queryOnly(store)).toBe(1);
      return allRows<{ n: number }>(readTx.prepare('SELECT count(*) AS n FROM personas'))[0]?.n;
    });

    expect(seen).toBe(1);
    expect(queryOnly(store)).toBe(0);

    expect(
      codeOf(() => withRead(store, (readTx) => readTx.prepare(WITH_INSERT).run(NOW, NOW))),
    ).toBe('read_only_violation');
    expect(personaIds(store)).toStrictEqual(['psn_seed']);

    // Nested read inside a standalone read scope still works.
    const nested = withRead(store, () =>
      withRead(store, (inner) =>
        allRows<{ n: number }>(inner.prepare('SELECT count(*) AS n FROM personas')),
      ),
    );
    expect(nested[0]?.n).toBe(1);
    expect(queryOnly(store)).toBe(0);
  });
});
