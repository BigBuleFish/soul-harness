import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { allRows } from '../src/db/rows.js';
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

describe('a sequence of migrations', () => {
  it('applies them in version order, not directory order', () => {
    const dir = tempDir();
    const migrationsDir = `${dir}/migrations`;

    // Written out of order on purpose; names sort differently from versions.
    writeMigrationFile(migrationsDir, '0003_c.sql', 'CREATE TABLE t3 (id TEXT);');
    writeMigrationFile(migrationsDir, '0001_a.sql', 'CREATE TABLE t1 (id TEXT);');
    writeMigrationFile(migrationsDir, '0002_b.sql', 'CREATE TABLE t2 (id TEXT);');

    const store = storeIn(dir);
    const result = migrate(store, { dir: migrationsDir });

    expect(result.applied).toStrictEqual([1, 2, 3]);
    expect(result.currentVersion).toBe(3);
    expect(tableNames(store)).toStrictEqual(['schema_migrations', 't1', 't2', 't3']);
  });

  it('is a no-op on the second run', () => {
    const dir = tempDir();
    const migrationsDir = `${dir}/migrations`;
    writeMigrationFile(migrationsDir, '0001_a.sql', 'CREATE TABLE t1 (id TEXT);');
    writeMigrationFile(migrationsDir, '0002_b.sql', 'CREATE TABLE t2 (id TEXT);');

    const store = storeIn(dir);
    expect(migrate(store, { dir: migrationsDir }).applied).toStrictEqual([1, 2]);

    const again = migrate(store, { dir: migrationsDir });
    expect(again.applied).toStrictEqual([]);
    expect(again.alreadyApplied).toStrictEqual([1, 2]);
  });

  it('tolerates a version gap (0001, 0003)', () => {
    const dir = tempDir();
    const migrationsDir = `${dir}/migrations`;
    writeMigrationFile(migrationsDir, '0001_a.sql', 'CREATE TABLE t1 (id TEXT);');
    writeMigrationFile(migrationsDir, '0003_c.sql', 'CREATE TABLE t3 (id TEXT);');

    const store = storeIn(dir);
    const result = migrate(store, { dir: migrationsDir });

    expect(result.applied).toStrictEqual([1, 3]);
    expect(tableNames(store)).toStrictEqual(['schema_migrations', 't1', 't3']);
  });
});
