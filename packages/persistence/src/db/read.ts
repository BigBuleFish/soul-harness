/**
 * Read-path database accessor for repositories.
 *
 * Repository *reads* do not open a transaction, so they would bypass the
 * coordinator's `assertUsable` check and keep working on a store whose cleanup
 * failed. "Unusable" must mean every operation, not only writes
 * (SH-006B/R3 semantics), so repository reads go through here.
 *
 * Writes are covered already: they enter `withWrite`, which rejects a poisoned
 * store before `BEGIN`.
 */

import type { DatabaseSync } from 'node:sqlite';

import { assertStoreUsable } from '../tx/coordinator.js';
import { databaseOf, type Store } from './store.js';

/** Returns the live handle for a repository read, or throws `store_unusable`. */
export function readDatabaseOf(store: Store): DatabaseSync {
  assertStoreUsable(store);
  return databaseOf(store);
}
