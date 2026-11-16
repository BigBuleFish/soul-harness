import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { migrate, openStore } from '../src/index.js';
import { defaultMigrationsDir } from '../src/migrations/migrator.js';
import type { Store } from '../src/index.js';
import { copyMigrations, dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

describe('checksum verification', () => {
  it('rejects a migration that changed after being applied', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    copyMigrations(defaultMigrationsDir(), migrationsDir);

    const store = openStore({ file: dbPathIn(dir) });
    stores.push(store);

    expect(migrate(store, { dir: migrationsDir }).applied).toStrictEqual([1]);

    // Tamper with the already-applied file.
    appendFileSync(join(migrationsDir, '0001_init_core.sql'), '\n-- tampered\n', 'utf8');

    try {
      migrate(store, { dir: migrationsDir });
      expect.unreachable('a modified applied migration must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe('migration_checksum_mismatch');
      expect((error as PersistenceError).details?.['version']).toBe(1);
    }

    // Nothing was re-applied or duplicated.
    const count = databaseOf(store)
      .prepare('SELECT count(*) AS n FROM schema_migrations')
      .get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
