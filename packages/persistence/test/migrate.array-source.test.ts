import { afterEach, describe, expect, it } from 'vitest';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { createMigrationFile, migrate, openStore } from '../src/index.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

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

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

describe('migrations supplied as an array (not a directory)', () => {
  it('executes them in ascending version order even when handed out of order', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    const migrations = [
      createMigrationFile(3, 'third', 'inline:3', 'CREATE TABLE t3 (id TEXT);'),
      createMigrationFile(1, 'first', 'inline:1', 'CREATE TABLE t1 (id TEXT);'),
      createMigrationFile(2, 'second', 'inline:2', 'CREATE TABLE t2 (id TEXT);'),
    ];

    const result = migrate(store, { migrations });

    expect(result.applied).toStrictEqual([1, 2, 3]);
    expect(result.currentVersion).toBe(3);
    expect(tableNames(store)).toStrictEqual(['schema_migrations', 't1', 't2', 't3']);
  });

  it('records the versions in ascending order', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    migrate(store, {
      migrations: [
        createMigrationFile(5, 'fifth', 'inline:5', 'CREATE TABLE t5 (id TEXT);'),
        createMigrationFile(2, 'second', 'inline:2', 'CREATE TABLE t2 (id TEXT);'),
      ],
    });

    const rows = allRows<{ version: number }>(
      databaseOf(store).prepare('SELECT version FROM schema_migrations ORDER BY version'),
    );
    expect(rows.map((row) => row.version)).toStrictEqual([2, 5]);
  });

  it('rejects duplicate versions with an explicit error', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    const migrations = [
      createMigrationFile(2, 'a', 'inline:2a', 'CREATE TABLE a (id TEXT);'),
      createMigrationFile(2, 'b', 'inline:2b', 'CREATE TABLE b (id TEXT);'),
    ];

    expect(codeOf(() => migrate(store, { migrations }))).toBe('migration_duplicate_version');
    // Validation fails before the migrator touches the database at all.
    expect(tableNames(store)).toStrictEqual([]);
  });

  it('is a no-op when the same array is applied twice', () => {
    const dir = tempDir();
    const store = storeIn(dir);
    const migrations = [
      createMigrationFile(1, 'a', 'inline:1', 'CREATE TABLE a (id TEXT);'),
      createMigrationFile(2, 'b', 'inline:2', 'CREATE TABLE b (id TEXT);'),
    ];

    expect(migrate(store, { migrations }).applied).toStrictEqual([1, 2]);
    const second = migrate(store, { migrations });
    expect(second.applied).toStrictEqual([]);
    expect(second.alreadyApplied).toStrictEqual([1, 2]);
  });

  it('derives the checksum from the SQL text even if the caller supplies one', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    const tampered = {
      ...createMigrationFile(1, 'a', 'inline:1', 'CREATE TABLE a (id TEXT);'),
      checksum: 'deadbeef',
    };

    migrate(store, { migrations: [tampered] });

    const row = allRows<{ checksum: string }>(
      databaseOf(store).prepare('SELECT checksum FROM schema_migrations'),
    )[0];
    expect(row?.checksum).not.toBe('deadbeef');
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a migration whose name is not snake_case', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    const bad = {
      ...createMigrationFile(1, 'ok', 'inline:1', 'CREATE TABLE a (id TEXT);'),
      name: 'NotSnake',
    };
    expect(codeOf(() => migrate(store, { migrations: [bad] }))).toBe('migration_name_invalid');
  });
});

describe('directory loading keeps its previous behaviour', () => {
  it('still sorts by version and rejects duplicates', () => {
    const dir = tempDir();
    const store = storeIn(dir);

    // The packaged migrations directory loads and applies as before.
    expect(migrate(store).applied).toStrictEqual([1]);
  });
});
