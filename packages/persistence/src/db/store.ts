/**
 * Opaque store handle.
 *
 * The underlying `DatabaseSync` is intentionally *not* reachable from the
 * package entry point: MODULES.md forbids other modules from touching the
 * database directly, and an exported handle would make that rule advisory.
 * Internal modules (migrator, repositories) obtain it through `databaseOf`,
 * which is not re-exported from `src/index.ts`, and `exports` in package.json
 * only exposes the root entry point.
 */

import type { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';

const databases = new WeakMap<Store, DatabaseSync>();
const closedStores = new WeakSet<Store>();

export class Store {
  /** Absolute path of the SQLite file backing this store. */
  readonly file: string;

  /** @internal Construct through `openStore()`; the constructor is not part of the public API. */
  constructor(file: string, database: DatabaseSync) {
    this.file = file;
    databases.set(this, database);
  }

  get isClosed(): boolean {
    return closedStores.has(this);
  }

  /**
   * Releases the database handle. Idempotent: a second call is a no-op.
   * WAL checkpointing on close is a Daemon concern (RUNTIME-LIFECYCLE §3 step 7).
   */
  close(): void {
    if (closedStores.has(this)) {
      return;
    }
    const database = databases.get(this);
    closedStores.add(this);
    databases.delete(this);
    database?.close();
  }
}

/** @internal Returns the live handle or throws when the store is already closed. */
export function databaseOf(store: Store): DatabaseSync {
  const database = databases.get(store);
  if (database === undefined) {
    throw new PersistenceError('store_closed', 'store is closed');
  }
  return database;
}
