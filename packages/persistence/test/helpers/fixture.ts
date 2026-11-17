/**
 * Shared test fixture: a migrated SQLite database in a temp directory.
 *
 * Uses the real open + migrate path; nothing here shortcuts the production code.
 */

import { allRows } from '../../src/db/rows.js';
import { databaseOf } from '../../src/db/store.js';
import { migrate, openStore, type Store } from '../../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

export const NOW = 1_731_700_000_000;

/** Opens a fresh database and applies the packaged migrations. */
export function openMigratedStore(): Store {
  const dir = makeTempDir();
  dirs.push(dir);
  const store = openStore({ file: dbPathIn(dir) });
  migrate(store);
  stores.push(store);
  return store;
}

/** Row count for a table; used to assert commit/rollback effects. */
export function countRows(store: Store, table: string): number {
  const rows = allRows<{ n: number }>(
    databaseOf(store).prepare(`SELECT count(*) AS n FROM ${table}`),
  );
  return rows[0]?.n ?? 0;
}

/** Closes every store and removes every temp directory created by the fixture. */
export function closeAll(): void {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
}
