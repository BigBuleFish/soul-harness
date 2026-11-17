import { afterEach, describe, expect, it } from 'vitest';

import type { PersistenceError } from '../src/errors.js';
import { firstKeyword, withRead, withWrite } from '../src/index.js';
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

describe('firstKeyword', () => {
  it.each([
    ['SELECT 1', 'SELECT'],
    ['  insert into t values (1)', 'INSERT'],
    ['-- comment\nUPDATE t SET a = 1', 'UPDATE'],
    ['/* block */ DELETE FROM t', 'DELETE'],
    ['/* a */ -- b\n  commit', 'COMMIT'],
    ['', ''],
    ['   ', ''],
    ['/* unterminated', ''],
    ['123', ''],
  ])('%j → %j', (sql, keyword) => {
    expect(firstKeyword(sql)).toBe(keyword);
  });
});

describe('transaction control is unreachable from a callback', () => {
  const controlStatements = [
    'COMMIT',
    'commit',
    'END',
    'ROLLBACK',
    'BEGIN IMMEDIATE',
    'SAVEPOINT sp1',
    'RELEASE sp1',
    'PRAGMA query_only = OFF',
    'PRAGMA journal_mode = DELETE',
    "ATTACH DATABASE 'other.db' AS other",
    'DETACH DATABASE other',
    '  /* leading comment */ COMMIT',
    '-- line comment\nROLLBACK',
  ];

  it.each(controlStatements)('rejects %j', (sql) => {
    const store = openMigratedStore();

    expect(
      codeOf(() =>
        withWrite(store, (tx) => {
          tx.prepare(sql);
        }),
      ),
    ).toBe('statement_blocked');

    expect(countRows(store, 'personas')).toBe(0);
  });

  it('rolls back earlier statements in the same transaction', () => {
    const store = openMigratedStore();

    expect(() =>
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
        tx.prepare('COMMIT');
      }),
    ).toThrow();

    expect(countRows(store, 'personas')).toBe(0);
  });

  it('leaves the connection usable after a blocked statement', () => {
    const store = openMigratedStore();

    expect(codeOf(() => withWrite(store, (tx) => tx.prepare('COMMIT')))).toBe('statement_blocked');

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    expect(countRows(store, 'personas')).toBe(1);
  });

  it('rejects an empty or keyword-less statement', () => {
    const store = openMigratedStore();

    expect(codeOf(() => withWrite(store, (tx) => tx.prepare('   ')))).toBe('invalid_argument');
  });
});

describe('the read surface restricts what can even be prepared', () => {
  it('refuses INSERT, UPDATE, DELETE and transaction control', () => {
    const store = openMigratedStore();
    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    for (const sql of [
      INSERT_PERSONA,
      'UPDATE personas SET display_name = ?',
      'DELETE FROM personas',
      'COMMIT',
      'PRAGMA query_only = OFF',
    ]) {
      expect(
        codeOf(() => withRead(store, (tx) => tx.prepare(sql))),
        sql,
      ).toBe('statement_blocked');
    }

    expect(countRows(store, 'personas')).toBe(1);
  });
});

describe('after every path the coordinator accepts new transactions', () => {
  it('works after a normal commit, a rollback and a blocked statement', () => {
    const store = openMigratedStore();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_1', 'Primary', 'CREATED', NOW, NOW);
    });

    expect(() =>
      withWrite(store, (tx) => {
        tx.prepare(INSERT_PERSONA).run('psn_2', 'Second', 'CREATED', NOW, NOW);
        throw new Error('rollback me');
      }),
    ).toThrow('rollback me');

    expect(codeOf(() => withWrite(store, (tx) => tx.prepare('COMMIT')))).toBe('statement_blocked');

    expect(() => withRead(store, () => 1)).not.toThrow();

    withWrite(store, (tx) => {
      tx.prepare(INSERT_PERSONA).run('psn_3', 'Third', 'CREATED', NOW, NOW);
    });

    expect(countRows(store, 'personas')).toBe(2);
  });
});
