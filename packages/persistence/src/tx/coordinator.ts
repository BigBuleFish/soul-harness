/**
 * Transaction coordinator — the single write entry point.
 *
 * Why there is no async queue: `node:sqlite` is synchronous and SQLite is a
 * single-writer database, so requiring synchronous callbacks IS the strongest
 * serialization guarantee — a transaction cannot be interleaved by an `await`
 * because nothing can yield inside it. Async callbacks are rejected instead of
 * being half-supported: an async body resumes after COMMIT and would write
 * outside the transaction.
 *
 * Control stays here, not in the callback:
 *   - the only handle is `prepare()` returning a guarded statement; there is no
 *     arbitrary `exec`, so BEGIN/COMMIT/ROLLBACK/PRAGMA/ATTACH are unreachable;
 *   - every statement and iterator re-checks that the transaction is still live;
 *   - `withRead` enforces read-only at the connection level (`query_only`) and
 *     its surface only prepares read statements.
 *
 * Nesting rules:
 *   - `withWrite` inside `withWrite` / `withRead` → `nested_write`
 *   - `withRead` inside `withWrite` / `withRead`  → joins the outer transaction
 */

import type { DatabaseSync } from 'node:sqlite';

import { classifyDatabaseError } from '../db/classify.js';
import { databaseOf, type Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { createGuardedStatement, type GuardedStatement, type RawStatement } from './statements.js';

/** Write transaction handle: prepare only, no transaction control. */
export interface Tx {
  readonly kind: 'write';
  prepare(sql: string): GuardedStatement;
}

/** Read transaction handle: read statements only. */
export interface ReadTx {
  readonly kind: 'read';
  prepare(sql: string): GuardedStatement;
}

/** A callback returning a promise cannot run inside a synchronous transaction. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

type Mode = 'idle' | 'write' | 'read';

interface CoordinatorState {
  mode: Mode;
}

const states = new WeakMap<Store, CoordinatorState>();

/**
 * Stores whose connection state could not be restored after a failed cleanup.
 * They refuse further transactions rather than pretending to be healthy.
 */
const unusable = new WeakSet<Store>();

/** True when a previous cleanup failure left the store in an unsafe state. */
export function isStoreUnusable(store: Store): boolean {
  return unusable.has(store);
}

function stateOf(store: Store): CoordinatorState {
  let state = states.get(store);
  if (state === undefined) {
    state = { mode: 'idle' };
    states.set(store, state);
  }
  return state;
}

function assertUsable(store: Store): void {
  if (unusable.has(store)) {
    throw new PersistenceError(
      'store_unusable',
      'store is unusable after a failed transaction cleanup; reopen it',
    );
  }
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
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

function handleFor(db: DatabaseSync, mode: 'write' | 'read', isActive: () => boolean): Tx | ReadTx {
  const factory = (sql: string): RawStatement => db.prepare(sql);
  const prepare = (sql: string): GuardedStatement =>
    createGuardedStatement(sql, mode, isActive, factory);

  return mode === 'write' ? { kind: 'write', prepare } : { kind: 'read', prepare };
}

/**
 * Restores `query_only = OFF` and poisons the store if that fails.
 *
 * The failure is swallowed on purpose: it must never replace the error already
 * propagating out of the transaction. The store refuses further work instead.
 */
function restoreQueryOnly(db: DatabaseSync, store: Store): void {
  try {
    db.exec('PRAGMA query_only = OFF');
  } catch {
    unusable.add(store);
  }
}

/**
 * Runs `fn` inside a single write transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front so a competing writer fails
 * fast (busy_timeout) instead of deadlocking half-way. Any throw — from `fn`, a
 * guarded statement, or COMMIT — rolls back before the error is classified.
 */
export function withWrite<T>(store: Store, fn: (tx: Tx) => T): NotPromise<T> {
  assertUsable(store);

  const db = databaseOf(store);
  const state = stateOf(store);

  if (state.mode !== 'idle') {
    throw new PersistenceError('nested_write', 'nested write transactions are not supported', {
      details: { mode: state.mode },
    });
  }

  state.mode = 'write';
  const tx = handleFor(db, 'write', () => state.mode === 'write') as Tx;

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
 * Standalone: `PRAGMA query_only = ON` makes writes fail inside SQLite itself,
 * and the read surface additionally refuses to prepare anything that does not
 * start with SELECT/WITH/VALUES/EXPLAIN.
 *
 * Joined: when already inside a transaction, the scope joins it — no inner
 * BEGIN and no pragma toggle, which would block writes the outer transaction
 * still needs to make.
 */
export function withRead<T>(store: Store, fn: (tx: ReadTx) => T): NotPromise<T> {
  assertUsable(store);

  const db = databaseOf(store);
  const state = stateOf(store);

  if (state.mode !== 'idle') {
    const joined = handleFor(db, 'read', () => state.mode !== 'idle') as ReadTx;
    return assertSynchronous(fn(joined), 'read transaction') as NotPromise<T>;
  }

  state.mode = 'read';
  const tx = handleFor(db, 'read', () => state.mode === 'read') as ReadTx;

  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN DEFERRED');
  } catch (error) {
    restoreQueryOnly(db, store);
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
    // Restore before releasing the mode: a failure poisons the store and must
    // never mask the error that is already propagating.
    restoreQueryOnly(db, store);
    state.mode = 'idle';
  }
}
