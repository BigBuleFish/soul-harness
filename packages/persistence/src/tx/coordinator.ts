/**
 * Transaction coordinator — the single write entry point.
 *
 * Why there is no async queue: `node:sqlite` is a synchronous API, and SQLite is
 * a single-writer database. Requiring synchronous callbacks is the strongest
 * possible serialization guarantee — a transaction cannot be interleaved by an
 * `await`, because there is nothing to interleave. Async callbacks are rejected
 * at runtime (and excluded by the return type) instead of being half-supported:
 * an async body would resume *after* COMMIT/ROLLBACK and write outside the
 * transaction, which is exactly the failure mode this module exists to prevent.
 *
 * Nesting rules:
 *   - `withWrite` inside `withWrite` → rejected (`nested_write`).
 *   - `withWrite` inside `withRead`  → rejected (`nested_write`).
 *   - `withRead` inside `withWrite`  → joins the outer write transaction.
 *   - `withRead` inside `withRead`   → joins the outer read transaction.
 *
 * `withRead` sets `PRAGMA query_only = ON` for the duration, so a write is
 * rejected by SQLite itself (read-only violation), not merely by convention.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { classifyDatabaseError } from '../db/classify.js';
import { databaseOf, type Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';

/** Handle passed to transaction callbacks; valid only inside the callback. */
export interface Tx {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
}

export type ReadTx = Tx;

type Mode = 'idle' | 'write' | 'read';

interface CoordinatorState {
  mode: Mode;
}

const states = new WeakMap<Store, CoordinatorState>();

function stateOf(store: Store): CoordinatorState {
  let state = states.get(store);
  if (state === undefined) {
    state = { mode: 'idle' };
    states.set(store, state);
  }
  return state;
}

/** A callback returning a promise cannot run inside a synchronous transaction. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}

function handleFor(db: DatabaseSync, isActive: () => boolean): Tx {
  const assertActive = (): void => {
    if (!isActive()) {
      throw new PersistenceError(
        'transaction_closed',
        'transaction handle used after the transaction ended',
      );
    }
  };

  return {
    prepare: (sql: string): StatementSync => {
      assertActive();
      return db.prepare(sql);
    },
    exec: (sql: string): void => {
      assertActive();
      db.exec(sql);
    },
  };
}

function assertSynchronous<T>(result: T, operation: string): T {
  if (isThenable(result)) {
    throw new PersistenceError(
      'async_callback_unsupported',
      `the ${operation} callback returned a promise; transaction callbacks must be synchronous`,
    );
  }
  return result;
}

/**
 * Runs `fn` inside a single write transaction.
 *
 * `BEGIN IMMEDIATE` acquires the write lock up front, so a competing writer
 * fails fast (busy_timeout) instead of deadlocking half-way. Any throw — from
 * `fn` or from COMMIT — rolls back before the error is classified.
 */
export function withWrite<T>(store: Store, fn: (tx: Tx) => T): NotPromise<T> {
  const db = databaseOf(store);
  const state = stateOf(store);

  if (state.mode !== 'idle') {
    throw new PersistenceError('nested_write', 'nested write transactions are not supported', {
      details: { mode: state.mode },
    });
  }

  state.mode = 'write';
  const tx = handleFor(db, () => state.mode === 'write');

  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    state.mode = 'idle';
    throw classifyDatabaseError(error, 'begin write transaction');
  }

  try {
    const result = assertSynchronous(fn(tx), 'write transaction');
    db.exec('COMMIT');
    return result as NotPromise<T>;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled back; the original error is what matters.
    }
    throw classifyDatabaseError(error, 'write transaction');
  } finally {
    state.mode = 'idle';
  }
}

/**
 * Runs `fn` inside a read-only scope.
 *
 * When called inside an existing transaction it joins it (no inner BEGIN, and no
 * `query_only` toggle — that would block writes the outer transaction still
 * needs to make).
 */
export function withRead<T>(store: Store, fn: (tx: ReadTx) => T): NotPromise<T> {
  const db = databaseOf(store);
  const state = stateOf(store);

  if (state.mode !== 'idle') {
    return assertSynchronous(
      fn(handleFor(db, () => state.mode !== 'idle')),
      'read transaction',
    ) as NotPromise<T>;
  }

  state.mode = 'read';
  const tx = handleFor(db, () => state.mode === 'read');

  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN DEFERRED');
  } catch (error) {
    db.exec('PRAGMA query_only = OFF');
    state.mode = 'idle';
    throw classifyDatabaseError(error, 'begin read transaction');
  }

  try {
    const result = assertSynchronous(fn(tx), 'read transaction');
    db.exec('COMMIT');
    return result as NotPromise<T>;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // See withWrite.
    }
    throw classifyDatabaseError(error, 'read transaction');
  } finally {
    db.exec('PRAGMA query_only = OFF');
    state.mode = 'idle';
  }
}
