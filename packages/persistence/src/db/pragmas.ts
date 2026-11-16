/**
 * Required connection pragmas.
 *
 * These are not tuning knobs: each one encodes a documented invariant.
 *   - `journal_mode=WAL`   — RUNTIME-LIFECYCLE §9 (readers do not block the writer)
 *   - `foreign_keys=ON`    — DATA-MODEL §3 (referential integrity is enforced by SQLite)
 *   - `secure_delete=ON`   — TRUST-BOUNDARIES §11.3 (deleted rows must not linger)
 *   - `busy_timeout`       — a second connection (recovery tools, tests) must not
 *                            fail instantly on a transient lock
 *
 * `node:sqlite` returns pragma values under specific column names; the two that
 * differ from their pragma name (`timeout`) are normalized here so callers never
 * have to know that.
 */

import type { DatabaseSync } from 'node:sqlite';

import { PersistenceError } from '../errors.js';

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface PragmaSnapshot {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly secureDelete: number;
  readonly busyTimeoutMs: number;
}

interface RawRow {
  readonly [key: string]: unknown;
}

function readRow(db: DatabaseSync, pragma: string): RawRow {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as RawRow | undefined;
  if (row === undefined) {
    throw new PersistenceError('pragma_not_applied', `PRAGMA ${pragma} returned no value`);
  }
  return row;
}

/** Applies the required pragmas. Must run outside any transaction. */
export function applyPragmas(
  db: DatabaseSync,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
}

/** Reads back the pragmas and fails loudly if any of them did not take effect. */
export function readPragmas(db: DatabaseSync): PragmaSnapshot {
  const journal = readRow(db, 'journal_mode');
  const foreign = readRow(db, 'foreign_keys');
  const secure = readRow(db, 'secure_delete');
  const busy = readRow(db, 'busy_timeout');

  const journalMode = journal['journal_mode'];
  if (typeof journalMode !== 'string') {
    throw new PersistenceError(
      'pragma_not_applied',
      'PRAGMA journal_mode returned a non-string value',
    );
  }

  return {
    journalMode,
    foreignKeys: Number(foreign['foreign_keys']),
    secureDelete: Number(secure['secure_delete']),
    // node:sqlite exposes busy_timeout as `timeout`.
    busyTimeoutMs: Number(busy['timeout']),
  };
}

/** Asserts the invariants the rest of the system relies on. */
export function assertPragmas(db: DatabaseSync, expectedBusyTimeoutMs: number): PragmaSnapshot {
  const snapshot = readPragmas(db);

  if (snapshot.journalMode.toLowerCase() !== 'wal') {
    throw new PersistenceError('pragma_not_applied', 'database is not in WAL mode', {
      details: { journalMode: snapshot.journalMode },
    });
  }
  if (snapshot.foreignKeys !== 1) {
    throw new PersistenceError('pragma_not_applied', 'foreign keys are not enabled');
  }
  if (snapshot.secureDelete !== 1) {
    throw new PersistenceError('pragma_not_applied', 'secure_delete is not enabled');
  }
  if (snapshot.busyTimeoutMs !== expectedBusyTimeoutMs) {
    throw new PersistenceError('pragma_not_applied', 'busy_timeout did not take effect', {
      details: { expected: expectedBusyTimeoutMs, actual: snapshot.busyTimeoutMs },
    });
  }

  return snapshot;
}
