/**
 * Migration APIs must respect the Store lifecycle (SH-006D.R1).
 *
 * `migrate()` and `verifySchema()` are public Persistence operations that take a
 * `Store`. Once a cleanup failure has poisoned that store, they must refuse
 * before touching the database — like repositories do.
 *
 * Post-failure database inspection uses an **independent** `node:sqlite`
 * connection: the poisoned store must not be used to prove that nothing changed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import {
  createMigrationFile,
  createRepositories,
  defaultMigrationsDir,
  isStoreUnusable,
  loadMigrationsFromDir,
  migrate,
  verifySchema,
  withRead,
  type Store,
} from '../src/index.js';
import { setReadGuardFaultForTests } from '../src/tx/read-guard-fault.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(() => {
  setReadGuardFaultForTests(null);
  closeAll();
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

/** Puts the store into the poisoned state through the real read-guard path. */
function poison(store: Store): void {
  setReadGuardFaultForTests((stage) =>
    stage === 'restore' ? new Error('simulated restore failure') : null,
  );

  expect(() => withRead(store, () => 1)).toThrow();
  expect(isStoreUnusable(store)).toBe(true);

  setReadGuardFaultForTests(null);
}

function seed(store: Store): void {
  const repos = createRepositories(store);
  repos.personas.insert({
    id: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
    displayName: 'Primary',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  } as never);
  repos.runtimeState.upsert({
    personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as never,
    state: 'RUNNING',
    epoch: 1,
    updatedAt: NOW,
  });
}

interface Snapshot {
  readonly migrations: readonly unknown[];
  readonly personas: readonly unknown[];
  readonly runtimeState: readonly unknown[];
  readonly tasks: readonly unknown[];
}

/** Reads the file through a separate connection — never through the poisoned store. */
function snapshot(file: string): Snapshot {
  const db = new DatabaseSync(file);
  try {
    const read = (sql: string): unknown[] =>
      JSON.parse(JSON.stringify(db.prepare(sql).all())) as unknown[];

    return {
      migrations: read(
        'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
      ),
      personas: read(
        'SELECT id, display_name, state, version, epoch, boot_id, created_at, updated_at FROM personas ORDER BY id',
      ),
      runtimeState: read(
        'SELECT persona_id, state, boot_id, epoch, checkpoint_json, updated_at FROM runtime_state ORDER BY persona_id',
      ),
      tasks: read('SELECT id, state FROM tasks ORDER BY id'),
    };
  } finally {
    db.close();
  }
}

describe('verifySchema refuses a poisoned store', () => {
  it('throws store_unusable and runs no schema query', () => {
    const store = openMigratedStore();
    seed(store);
    expect(() => verifySchema(store)).not.toThrow();

    poison(store);

    expect(codeOf(() => verifySchema(store))).toBe('store_unusable');
  });
});

describe('migrate refuses a poisoned store', () => {
  it('throws store_unusable before reading migration state', () => {
    const store = openMigratedStore();
    seed(store);
    expect(migrate(store).applied).toStrictEqual([]);

    poison(store);

    expect(codeOf(() => migrate(store))).toBe('store_unusable');
  });

  it('does not even validate a malformed migration set', () => {
    const store = openMigratedStore();
    poison(store);

    const first = createMigrationFile(1, 'a', '/tmp/a.sql', 'CREATE TABLE a (id TEXT);');
    const second = createMigrationFile(1, 'b', '/tmp/b.sql', 'CREATE TABLE b (id TEXT);');

    // On a healthy store this would be `migration_duplicate_version`; the guard
    // runs first, so the duplicate never reaches the loader.
    expect(codeOf(() => migrate(store, { migrations: [first, second] }))).toBe('store_unusable');
  });
});

describe('a poisoned store cannot change the database', () => {
  it('leaves migrations and business tables byte-identical', () => {
    const store = openMigratedStore();
    seed(store);

    const before = snapshot(store.file);

    poison(store);

    expect(codeOf(() => verifySchema(store))).toBe('store_unusable');
    expect(codeOf(() => migrate(store))).toBe('store_unusable');

    const after = snapshot(store.file);

    expect(after).toStrictEqual(before);
    expect(after.migrations).toHaveLength(1);
    expect(after.personas).toHaveLength(1);

    const checksumBefore = (before.migrations[0] as { checksum: string }).checksum;
    const checksumAfter = (after.migrations[0] as { checksum: string }).checksum;
    expect(checksumAfter).toBe(checksumBefore);
  });
});

describe('the normal lifecycle is unchanged', () => {
  it('verifies a healthy schema and keeps migrate idempotent', () => {
    const store = openMigratedStore();

    expect(() => verifySchema(store)).not.toThrow();

    const first = migrate(store);
    expect(first.applied).toStrictEqual([]);
    expect(first.alreadyApplied).toStrictEqual([1]);
    expect(first.currentVersion).toBe(1);

    expect(isStoreUnusable(store)).toBe(false);
  });

  it('reports a closed store as store_closed, not store_unusable', () => {
    const store = openMigratedStore();
    store.close();

    expect(codeOf(() => verifySchema(store))).toBe('store_closed');
    expect(codeOf(() => migrate(store))).toBe('store_closed');
    expect(isStoreUnusable(store)).toBe(false);
  });

  it('still applies a pending migration on a healthy store', () => {
    const store = openMigratedStore();
    const extra = createMigrationFile(
      2,
      'add_probe',
      '/tmp/0002_add_probe.sql',
      'CREATE TABLE probe (id TEXT PRIMARY KEY);',
    );

    // The applied set must stay visible, otherwise the migrator (correctly)
    // reports that an applied migration is missing from the source tree.
    const source = loadMigrationsFromDir(defaultMigrationsDir());
    const result = migrate(store, { migrations: [...source, extra] });

    expect(result.applied).toStrictEqual([2]);
    expect(
      allRows<{ name: string }>(
        databaseOf(store).prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'",
        ),
      ),
    ).toHaveLength(1);
  });
});
