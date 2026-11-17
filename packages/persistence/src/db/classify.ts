/**
 * SQLite error classification.
 *
 * `node:sqlite` exposes extended result codes on the thrown error (`errcode`),
 * which lets us distinguish a unique conflict from a foreign-key violation
 * without parsing English prose. The message fallbacks exist only because the
 * extended code is not always populated; they are a safety net, not the primary
 * signal.
 *
 * Deliberately narrow: an error that is NOT a SQLite error (no numeric errcode)
 * is returned unchanged. Application errors thrown inside a transaction callback
 * must reach the caller as-is — wrapping them would lose their identity and
 * make `instanceof` checks fail.
 */

import { PersistenceError } from '../errors.js';

const SQLITE_READONLY = 8;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_CHECK = 275;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_NOTNULL = 1299;

const MESSAGE_LIMIT = 200;

interface SqliteErrorLike {
  readonly errcode?: unknown;
  readonly message?: unknown;
}

function errcodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const value = (error as SqliteErrorLike).errcode;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, MESSAGE_LIMIT);
  }
  return String(error).slice(0, MESSAGE_LIMIT);
}

/**
 * Returns a `PersistenceError` for database failures, or the original value when
 * the error did not come from SQLite.
 */
export function classifyDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof PersistenceError) {
    return error;
  }

  const errcode = errcodeOf(error);
  if (errcode === null) {
    // Not a database error (application error, programming error, …).
    return error;
  }

  const details = { operation, errcode };

  if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
    return new PersistenceError(
      'unique_conflict',
      `unique constraint violated during ${operation}`,
      {
        cause: error,
        details,
      },
    );
  }
  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) {
    return new PersistenceError(
      'foreign_key_violation',
      `foreign key violated during ${operation}`,
      { cause: error, details },
    );
  }
  if (errcode === SQLITE_CONSTRAINT_CHECK) {
    return new PersistenceError(
      'check_violation',
      `check constraint violated during ${operation}`,
      {
        cause: error,
        details,
      },
    );
  }
  if (errcode === SQLITE_CONSTRAINT_NOTNULL) {
    return new PersistenceError('not_null_violation', `not null violated during ${operation}`, {
      cause: error,
      details,
    });
  }
  if (errcode === SQLITE_READONLY) {
    return new PersistenceError(
      'read_only_violation',
      `write attempted on a read-only transaction during ${operation}`,
      { cause: error, details },
    );
  }

  return new PersistenceError(
    'db_error',
    `database error during ${operation}: ${messageOf(error)}`,
    {
      cause: error,
      details,
    },
  );
}
