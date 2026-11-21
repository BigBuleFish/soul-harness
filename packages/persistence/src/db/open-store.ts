/**
 * Store lifecycle: open, configure, verify, close.
 *
 * Opening is deliberately dumb — it creates the parent directory, opens the
 * file, applies the required pragmas and proves they took effect. It does NOT
 * run migrations: RUNTIME-LIFECYCLE §2 makes "open, migrate, recover" three
 * explicit ordered steps, so the caller keeps control of that order.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';
import { DEFAULT_BUSY_TIMEOUT_MS, applyPragmas, assertPragmas } from './pragmas.js';
import { createStore, type Store } from './store.js';

export interface OpenStoreOptions {
  /** Path of the SQLite file. Relative paths resolve against `process.cwd()`. */
  readonly file: string;
  /** Defaults to 5000 ms. Exposed mainly so tests can assert the pragma round-trip. */
  readonly busyTimeoutMs?: number;
}

/**
 * Opens (creating if necessary) the SQLite file and returns an opaque store.
 * Throws `PersistenceError` with `store_open_failed` or `pragma_not_applied`.
 */
export function openStore(options: OpenStoreOptions): Store {
  const file = resolve(options.file);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch (error) {
    throw new PersistenceError('store_open_failed', 'could not create the database directory', {
      cause: error,
      details: { file },
    });
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file);
  } catch (error) {
    throw new PersistenceError('store_open_failed', 'could not open the database file', {
      cause: error,
      details: { file },
    });
  }

  try {
    applyPragmas(database, busyTimeoutMs);
    assertPragmas(database, busyTimeoutMs);
  } catch (error) {
    database.close();
    throw error;
  }

  return createStore(file, database);
}
