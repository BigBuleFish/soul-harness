import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { allRows } from '../src/db/rows.js';
import { PersistenceError } from '../src/errors.js';
import { migrate, openStore } from '../src/index.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir, writeMigrationFile } from './helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

function storeIn(dir: string): Store {
  const store = openStore({ file: dbPathIn(dir) });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tableNames(store: Store): readonly string[] {
  const rows = allRows<{ name: string }>(
    databaseOf(store).prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ),
  );
  return rows.map((row) => row.name);
}

function rowCount(store: Store, table: string): number {
  const row = databaseOf(store).prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

describe('a migration that fails midway', () => {
  it('rolls back its own DDL and leaves no tracking row', () => {
    const dir = tempDir();
    const migrationsDir = `${dir}/migrations`;
    writeMigrationFile(migrationsDir, '0001_a.sql', 'CREATE TABLE t1 (id TEXT);');
    writeMigrationFile(
      migrationsDir,
      '0002_b.sql',
      'CREATE TABLE t2 (id TEXT);\nINSERT INTO table_that_does_not_exist (id) VALUES (1);',
    );

    const store = storeIn(dir);

    try {
      migrate(store, { dir: migrationsDir });
      expect.unreachable('the broken migration must abort the run');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe('migration_failed');
      expect((error as PersistenceError).details?.['version']).toBe(2);
    }

    // 0001 committed, 0002 fully rolled back.
    expect(tableNames(store)).toStrictEqual(['schema_migrations', 't1']);
    expect(rowCount(store, 'schema_migrations')).toBe(1);
  });

  it('leaves no user tables when the first migration fails', () => {
    const dir = tempDir();
    const migrationsDir = `${dir}/migrations`;
    writeMigrationFile(
      migrationsDir,
      '0001_broken.sql',
      'CREATE TABLE t1 (id TEXT);\nBOGUS STATEMENT;',
    );

    const store = storeIn(dir);
    expect(() => migrate(store, { dir: migrationsDir })).toThrow(PersistenceError);

    // The bootstrap tracking table exists (the migrator creates it up front),
    // but the failed migration left no table and no tracking row behind.
    expect(tableNames(store)).toStrictEqual(['schema_migrations']);
    expect(rowCount(store, 'schema_migrations')).toBe(0);
  });
});
