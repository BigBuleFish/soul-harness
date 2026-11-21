/**
 * Opaque store handle.
 *
 * The underlying `DatabaseSync` is intentionally *not* reachable from the
 * package entry point: MODULES.md forbids other modules from touching the
 * database directly, and an exported handle would make that rule advisory.
 * Internal modules (migrator, repositories) obtain it through `databaseOf`,
 * which is not re-exported from `src/index.ts`, and `exports` in package.json
 * only exposes the root entry point.
 *
 * Construction is guarded at runtime, not just by the type system: the
 * constructor requires a module-private token that only `createStore()` can
 * supply, and `createStore()` is not exported from the package entry point.
 * A plain JavaScript caller that bypasses the type checker still fails.
 */

import { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';

const databases = new WeakMap<Store, DatabaseSync>();
const closedStores = new WeakSet<Store>();

/** Module-private construction capability; never exported. */
const STORE_CONSTRUCTION: unique symbol = Symbol('soul-harness.Store.construction');

export class Store {
  /** Absolute path of the SQLite file backing this store. */
  readonly file: string;

  /**
   * @internal Use `openStore()`. The token is a module-private symbol, so the
   * constructor cannot be called successfully from outside this module even
   * from plain JavaScript.
   */
  private constructor(file: string, database: DatabaseSync, token: typeof STORE_CONSTRUCTION) {
    if (token !== STORE_CONSTRUCTION) {
      // A caller bypassed openStore(): never take ownership of the smuggled
      // handle, and close it so the failed construction leaves no open
      // connection behind. `openStore()` never reaches this branch.
      if (database instanceof DatabaseSync) {
        try {
          database.close();
        } catch {
          // Already closed by the caller; nothing to release.
        }
      }
      throw new PersistenceError(
        'invalid_argument',
        'Store instances must be created through openStore()',
        { details: { operation: 'construct Store' } },
      );
    }
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

/**
 * @internal The only factory for `Store`; called by `openStore()` after the
 * directory, pragmas and verification succeeded. Not exported from the package
 * entry point, and the package `exports` map blocks deep imports by package
 * specifier.
 */
export function createStore(file: string, database: DatabaseSync): Store {
  return Reflect.construct(Store, [file, database, STORE_CONSTRUCTION]) as Store;
}

/** @internal Returns the live handle or throws when the store is already closed. */
export function databaseOf(store: Store): DatabaseSync {
  const database = databases.get(store);
  if (database === undefined) {
    throw new PersistenceError('store_closed', 'store is closed');
  }
  return database;
}
