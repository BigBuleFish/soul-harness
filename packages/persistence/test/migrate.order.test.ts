import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

describe('migration ordering anomalies', () => {
  it('rejects two files sharing a version', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    writeMigrationFile(migrationsDir, '0002_a.sql', 'CREATE TABLE a (id TEXT);');
    writeMigrationFile(migrationsDir, '0002_b.sql', 'CREATE TABLE b (id TEXT);');

    const store = storeIn(dir);
    expect(codeOf(() => migrate(store, { dir: migrationsDir }))).toBe(
      'migration_duplicate_version',
    );
  });

  it('rejects a file name that is not NNNN_snake.sql', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    writeMigrationFile(migrationsDir, '0001_good.sql', 'CREATE TABLE a (id TEXT);');
    writeMigrationFile(migrationsDir, '2-bad.sql', 'CREATE TABLE b (id TEXT);');

    const store = storeIn(dir);
    expect(codeOf(() => migrate(store, { dir: migrationsDir }))).toBe('migration_name_invalid');
  });

  it('rejects a pending migration older than an applied one', () => {
    const dir = tempDir();
    const first = join(dir, 'm1');
    writeMigrationFile(first, '0001_a.sql', 'CREATE TABLE a (id TEXT);');
    writeMigrationFile(first, '0003_c.sql', 'CREATE TABLE c (id TEXT);');

    const store = storeIn(dir);
    expect(migrate(store, { dir: first }).applied).toStrictEqual([1, 3]);

    // Now the tree suddenly contains 0002: it would have to run before 0003.
    const second = join(dir, 'm2');
    writeMigrationFile(second, '0001_a.sql', 'CREATE TABLE a (id TEXT);');
    writeMigrationFile(second, '0002_b.sql', 'CREATE TABLE b (id TEXT);');
    writeMigrationFile(second, '0003_c.sql', 'CREATE TABLE c (id TEXT);');

    expect(codeOf(() => migrate(store, { dir: second }))).toBe('migration_out_of_order');
  });

  it('rejects a database that claims a migration missing from the tree', () => {
    const dir = tempDir();
    const full = join(dir, 'full');
    writeMigrationFile(full, '0001_a.sql', 'CREATE TABLE a (id TEXT);');
    writeMigrationFile(full, '0002_b.sql', 'CREATE TABLE b (id TEXT);');

    const store = storeIn(dir);
    expect(migrate(store, { dir: full }).applied).toStrictEqual([1, 2]);

    const shrunk = join(dir, 'shrunk');
    writeMigrationFile(shrunk, '0001_a.sql', 'CREATE TABLE a (id TEXT);');

    expect(codeOf(() => migrate(store, { dir: shrunk }))).toBe('migration_not_found');
  });
});
