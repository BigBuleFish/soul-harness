import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { allRows } from '../src/db/rows.js';
import {
  defaultMigrationsDir,
  loadMigrationsFromDir,
  migrate,
  openStore,
  verifySchema,
} from '../src/index.js';
import { P1_INDEXES, P1_TABLE_COLUMNS } from '../src/migrations/expected-schema.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

function freshStore(): Store {
  const dir = makeTempDir();
  dirs.push(dir);
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

describe('migrate on an empty database', () => {
  it('applies 0001 and reports it', () => {
    const store = freshStore();
    const result = migrate(store);

    expect(result.applied).toStrictEqual([1]);
    expect(result.alreadyApplied).toStrictEqual([]);
    expect(result.currentVersion).toBe(1);
  });

  it('creates exactly the six P1 tables and six indexes', () => {
    const store = freshStore();
    migrate(store);

    const db = databaseOf(store);
    const tables = allRows<{ name: string }>(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    );

    expect(tables.map((row) => row.name)).toStrictEqual(Object.keys(P1_TABLE_COLUMNS).sort());

    const indexes = allRows<{ name: string }>(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    );

    expect(indexes.map((row) => row.name)).toStrictEqual([...P1_INDEXES].sort());
  });

  it('passes verifySchema', () => {
    const store = freshStore();
    migrate(store);
    expect(() => verifySchema(store)).not.toThrow();
  });

  it('records version, name, checksum and applied_at', () => {
    const store = freshStore();
    migrate(store);

    const migrations = loadMigrationsFromDir(defaultMigrationsDir());
    const expected = migrations[0];
    expect(expected).toBeDefined();

    const row = databaseOf(store)
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations')
      .get() as { version: number; name: string; checksum: string; applied_at: number };

    expect(row.version).toBe(expected?.version);
    expect(row.name).toBe(expected?.name);
    expect(row.checksum).toBe(expected?.checksum);
    expect(Number.isInteger(row.applied_at)).toBe(true);
    expect(row.applied_at).toBeGreaterThan(0);
  });

  it('keeps the connection pragmas in place after migrating', () => {
    const store = freshStore();
    migrate(store);

    const db = databaseOf(store);
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    expect(journal.journal_mode.toLowerCase()).toBe('wal');
    expect(fk.foreign_keys).toBe(1);
  });
});
