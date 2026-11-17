/**
 * Guarded statements — the only way transaction callbacks touch the database.
 *
 * Two problems this layer solves:
 *
 * 1. **Lifetime.** A raw `StatementSync` keeps working after the transaction
 *    ended: capturing it inside the callback and calling `run()` later would
 *    write outside the transaction that was supposed to contain it. Every call
 *    here re-checks that the transaction is still active, and iterators check on
 *    each `next()` so a half-consumed result set cannot outlive the transaction.
 *
 * 2. **Control.** `db.prepare('COMMIT')` is accepted by SQLite and really does
 *    commit, which would let a callback take the transaction boundary away from
 *    the coordinator. The gate below rejects transaction-control statements,
 *    PRAGMAs (including `query_only`) and ATTACH/DETACH before they are
 *    prepared.
 *
 * The gate inspects the *leading keyword* of the (comment-stripped) statement —
 * not a substring scan — and relies on the driver's single-statement behaviour
 * (`node:sqlite` silently ignores everything after the first `;`, verified on
 * Node 24.21).
 */

import type { SQLInputValue } from 'node:sqlite';

import { PersistenceError } from '../errors.js';

/** Outcome of a non-query statement. */
export interface StatementRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** The full statement surface exposed to a transaction callback. */
export interface GuardedStatement {
  run(...params: SQLInputValue[]): StatementRunResult;
  get(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown;
  iterate(...params: SQLInputValue[]): IterableIterator<unknown>;
}

/** Structural view of a raw driver statement; keeps `node:sqlite` out of the API. */
export interface RawStatement {
  run(...params: SQLInputValue[]): StatementRunResult;
  get(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown;
  iterate(...params: SQLInputValue[]): IterableIterator<unknown>;
}

/** Statements that would move the transaction boundary or reconfigure the connection. */
const BLOCKED_KEYWORDS: ReadonlySet<string> = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
]);

/** A read-only transaction may only prepare these. */
const READ_KEYWORDS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES', 'EXPLAIN']);

/**
 * Extracts the first SQL keyword, skipping whitespace and `--` / block comments.
 * Returns an empty string when the statement has no keyword at all.
 */
export function firstKeyword(sql: string): string {
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === undefined) {
      break;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      if (newline === -1) {
        return '';
      }
      index = newline + 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close === -1) {
        return '';
      }
      index = close + 2;
      continue;
    }
    break;
  }

  const match = /^[A-Za-z]+/.exec(sql.slice(index));
  return match === null ? '' : match[0].toUpperCase();
}

/**
 * Validates that `sql` is something a transaction callback may run.
 *
 * @throws PersistenceError `statement_blocked` for control statements / pragmas
 * @throws PersistenceError `invalid_argument` when no keyword can be found
 */
export function assertStatementAllowed(sql: string, mode: 'write' | 'read'): string {
  const keyword = firstKeyword(sql);

  if (keyword === '') {
    throw new PersistenceError('invalid_argument', 'statement has no SQL keyword', {
      details: { mode },
    });
  }
  if (BLOCKED_KEYWORDS.has(keyword)) {
    throw new PersistenceError(
      'statement_blocked',
      `statement ${keyword} is not allowed inside a transaction callback`,
      { details: { keyword } },
    );
  }
  if (mode === 'read' && !READ_KEYWORDS.has(keyword)) {
    throw new PersistenceError(
      'statement_blocked',
      `read transaction may only prepare read statements, got ${keyword}`,
      { details: { keyword } },
    );
  }

  return keyword;
}

function wrapIterator(
  source: Iterator<unknown>,
  isActive: () => boolean,
): IterableIterator<unknown> {
  const guard = (): void => {
    if (!isActive()) {
      throw new PersistenceError(
        'transaction_closed',
        'iterator consumed after the transaction ended',
      );
    }
  };

  const iterator: IterableIterator<unknown> = {
    next: (): IteratorResult<unknown> => {
      guard();
      return source.next();
    },
    return: (value?: unknown): IteratorResult<unknown> => {
      guard();
      return source.return === undefined ? { done: true, value } : source.return(value);
    },
    throw: (error?: unknown): IteratorResult<unknown> => {
      guard();
      if (source.throw === undefined) {
        throw error;
      }
      return source.throw(error);
    },
    [Symbol.iterator]: (): IterableIterator<unknown> => iterator,
  };

  return iterator;
}

/**
 * Wraps a driver statement so every execution checks the transaction is live.
 * The raw statement never leaves this closure.
 */
export function createGuardedStatement(
  sql: string,
  mode: 'write' | 'read',
  isActive: () => boolean,
  factory: (query: string) => RawStatement,
): GuardedStatement {
  assertStatementAllowed(sql, mode);

  const statement = factory(sql);

  const guard = (): void => {
    if (!isActive()) {
      throw new PersistenceError(
        'transaction_closed',
        'statement used after the transaction ended',
      );
    }
  };

  return {
    run: (...params: SQLInputValue[]): StatementRunResult => {
      guard();
      return statement.run(...params);
    },
    get: (...params: SQLInputValue[]): unknown => {
      guard();
      return statement.get(...params);
    },
    all: (...params: SQLInputValue[]): unknown => {
      guard();
      return statement.all(...params);
    },
    iterate: (...params: SQLInputValue[]): IterableIterator<unknown> => {
      guard();
      return wrapIterator(statement.iterate(...params), isActive);
    },
  };
}
