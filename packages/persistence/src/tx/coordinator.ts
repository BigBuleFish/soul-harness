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
 *   - every read scope — standalone OR nested inside a write transaction —
 *     enables the connection-level `query_only` guard for its duration, so a
 *     write is rejected by SQLite itself rather than by SQL inspection.
 *
 * Cleanup semantics: if the read guard cannot be restored, the connection state
 * is unknown. The store is marked unusable and the failure is reported to the
 * caller — unless the callback already threw, in which case that error keeps its
 * identity and the cleanup failure becomes the recorded reason for `store_unusable`.
 *
 * Nesting rules:
 *   - `withWrite` inside `withWrite` / `withRead` → `nested_write`
 *   - `withRead` inside `withWrite` / `withRead`  → joins the outer transaction,
 *     with the read-only guard applied as a depth-counted overlay
 */

import type { DatabaseSync } from 'node:sqlite';

import { classifyDatabaseError } from '../db/classify.js';
import { databaseOf, type Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { takeReadGuardFault } from './read-guard-fault.js';
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
  /** How many read scopes are currently open (0 = connection is writable). */
  readOnlyDepth: number;
  /** `query_only` value to restore when the outermost read scope closes. */
  queryOnlyBefore: 0 | 1;
}

const states = new WeakMap<Store, CoordinatorState>();

/**
 * Stores whose connection state could not be restored after a failed cleanup.
 * They refuse further transactions rather than pretending to be healthy.
 */
const unusable = new WeakSet<Store>();

/** Why a store became unusable; attached as `cause` to later rejections. */
const unusableReasons = new WeakMap<Store, PersistenceError>();

/** True when a previous cleanup failure left the store in an unsafe state. */
export function isStoreUnusable(store: Store): boolean {
  return unusable.has(store);
}

function stateOf(store: Store): CoordinatorState {
  let state = states.get(store);
  if (state === undefined) {
    state = { mode: 'idle', readOnlyDepth: 0, queryOnlyBefore: 0 };
    states.set(store, state);
  }
  return state;
}

function markUnusable(store: Store, reason: PersistenceError): void {
  if (!unusable.has(store)) {
    unusableReasons.set(store, reason);
  }
  unusable.add(store);
}

function assertUsable(store: Store): void {
  if (!unusable.has(store)) {
    return;
  }

  throw unusableError(store);
}

/** Stable failure used whenever work is attempted on a poisoned store. */
function unusableError(store: Store): PersistenceError {
  const reason = unusableReasons.get(store);
  return new PersistenceError(
    'store_unusable',
    'store is unusable after a failed transaction cleanup; reopen it',
    reason === undefined ? undefined : { cause: reason },
  );
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

/**
 * Builds the transaction handle.
 *
 * A poisoned store invalidates the *current* transaction too: `prepare` refuses
 * with `store_unusable`, and statements captured earlier stop executing because
 * liveness now also requires the store to be usable. Callbacks therefore cannot
 * keep writing after a nested cleanup failure, even when they swallow the error.
 */
function handleFor(
  store: Store,
  db: DatabaseSync,
  mode: 'write' | 'read',
  isActive: () => boolean,
): Tx | ReadTx {
  const factory = (sql: string): RawStatement => db.prepare(sql);
  const isLive = (): boolean => isActive() && !unusable.has(store);
  const prepare = (sql: string): GuardedStatement => {
    assertUsable(store);
    return createGuardedStatement(sql, mode, isLive, factory);
  };

  return mode === 'write' ? { kind: 'write', prepare } : { kind: 'read', prepare };
}

function readQueryOnly(db: DatabaseSync, store: Store): 0 | 1 {
  try {
    const row = db.prepare('PRAGMA query_only').get() as { query_only?: unknown } | undefined;
    return row?.query_only === 1 ? 1 : 0;
  } catch (error) {
    const reason = new PersistenceError(
      'store_unusable',
      'cannot read the query_only pragma; connection state is unknown',
      { cause: error, details: { operation: 'read guard' } },
    );
    markUnusable(store, reason);
    throw reason;
  }
}

/**
 * Enables the connection-level read-only guard, counting nested scopes.
 *
 * The first scope flips `query_only` ON and remembers the previous value; later
 * scopes only bump the counter. This is what makes a *nested* read scope safe:
 * inside an open write transaction the pragma still applies (verified on real
 * SQLite), so `INSERT` / `UPDATE` / `DELETE` — including `WITH …` forms — are
 * rejected by SQLite itself, while reads still see the transaction's uncommitted
 * rows.
 */
function beginReadGuard(store: Store, db: DatabaseSync): void {
  const state = stateOf(store);

  if (state.readOnlyDepth === 0) {
    const previous = readQueryOnly(db, store);

    try {
      const fault = takeReadGuardFault('enable');
      if (fault !== null) {
        throw fault;
      }
      db.exec('PRAGMA query_only = ON');
    } catch (error) {
      const reason = new PersistenceError(
        'store_unusable',
        'failed to enable the read-only guard; connection state is unknown',
        { cause: error, details: { operation: 'enable read guard' } },
      );
      markUnusable(store, reason);
      throw reason;
    }

    state.queryOnlyBefore = previous;
  }

  state.readOnlyDepth += 1;
}

/**
 * Releases one read scope and restores the pragma when the outermost one closes.
 *
 * Returns the cleanup failure instead of throwing: the caller decides whether it
 * becomes the outcome (callback succeeded → report it) or stays diagnostic
 * (callback already failed → keep that error). Either way the store is poisoned.
 */
function endReadGuard(store: Store, db: DatabaseSync): PersistenceError | null {
  const state = stateOf(store);

  if (state.readOnlyDepth === 0) {
    return null;
  }

  state.readOnlyDepth -= 1;
  if (state.readOnlyDepth > 0) {
    return null;
  }

  try {
    const fault = takeReadGuardFault('restore');
    if (fault !== null) {
      throw fault;
    }
    db.exec(`PRAGMA query_only = ${state.queryOnlyBefore === 1 ? 'ON' : 'OFF'}`);
    return null;
  } catch (error) {
    const reason = new PersistenceError(
      'store_unusable',
      'failed to restore the read-only guard; connection state is unknown',
      { cause: error, details: { operation: 'restore read guard' } },
    );
    markUnusable(store, reason);
    return reason;
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
  const tx = handleFor(store, db, 'write', () => state.mode === 'write') as Tx;

  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    state.mode = 'idle';
    throw classifyDatabaseError(error, 'begin write transaction');
  }

  try {
    const result = assertSynchronous(fn(tx), 'write transaction');

    // The callback may have swallowed a nested cleanup failure. The transaction
    // is no longer trustworthy, so it is never committed: throwing here routes
    // through the rollback path below.
    if (unusable.has(store)) {
      throw unusableError(store);
    }

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
 * Standalone: opens its own `BEGIN DEFERRED` transaction.
 * Joined: when already inside a transaction, the scope joins it — no inner BEGIN
 * and no transaction boundary of its own — but it still applies the read-only
 * guard as an overlay, so writes are impossible even when the outer scope is a
 * write transaction. See `beginReadGuard`.
 *
 * In both cases the read surface only prepares SELECT/WITH/VALUES/EXPLAIN, and
 * the guard (not the keyword check) is what stops `WITH … INSERT` and friends.
 */
export function withRead<T>(store: Store, fn: (tx: ReadTx) => T): NotPromise<T> {
  assertUsable(store);

  const db = databaseOf(store);
  const state = stateOf(store);
  const joined = state.mode !== 'idle';
  const operation = joined ? 'read scope' : 'read transaction';

  if (!joined) {
    state.mode = 'read';
  }

  try {
    beginReadGuard(store, db);
  } catch (error) {
    if (!joined) {
      state.mode = 'idle';
    }
    throw error;
  }

  const isActive = (): boolean => (joined ? state.mode !== 'idle' : state.mode === 'read');
  const tx = handleFor(store, db, 'read', isActive) as ReadTx;

  let result: T | undefined;
  let failure: { readonly error: unknown } | null = null;

  try {
    if (!joined) {
      db.exec('BEGIN DEFERRED');
    }

    result = assertSynchronous(fn(tx), operation);

    if (!joined) {
      db.exec('COMMIT');
    }
  } catch (error) {
    failure = { error };
    if (!joined) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // See withWrite.
      }
    }
  }

  // Restore the guard before releasing the mode. A restore failure poisons the
  // store; it is only reported as the outcome when the body itself succeeded, so
  // it can never replace an error the callback already raised.
  const cleanupFailure = endReadGuard(store, db);

  if (!joined) {
    state.mode = 'idle';
  }

  if (failure !== null) {
    throw classifyDatabaseError(failure.error, operation);
  }
  if (cleanupFailure !== null) {
    throw cleanupFailure;
  }

  return result as NotPromise<T>;
}
