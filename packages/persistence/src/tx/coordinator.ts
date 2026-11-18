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
 * Nesting rules:
 *   - `withWrite` inside `withWrite` / `withRead` → `nested_write`
 *   - `withRead` inside `withWrite` / `withRead`  → joins the outer transaction,
 *     with the read-only guard applied as a depth-counted overlay
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

function readQueryOnly(db: DatabaseSync, store: Store): 0 | 1 {
  try {
    const row = db.prepare('PRAGMA query_only').get() as { query_only?: unknown } | undefined;
    return row?.query_only === 1 ? 1 : 0;
  } catch {
    unusable.add(store);
    throw new PersistenceError(
      'store_unusable',
      'cannot read the query_only pragma; connection state is unknown',
    );
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
      db.exec('PRAGMA query_only = ON');
    } catch (error) {
      unusable.add(store);
      throw classifyDatabaseError(error, 'enable read-only guard');
    }

    state.queryOnlyBefore = previous;
  }

  state.readOnlyDepth += 1;
}

/**
 * Releases one read scope and restores the pragma when the outermost one closes.
 *
 * A restore failure poisons the store: it must never be reported as success, and
 * it must never replace the error already propagating out of the transaction.
 */
function endReadGuard(store: Store, db: DatabaseSync): void {
  const state = stateOf(store);

  if (state.readOnlyDepth === 0) {
    return;
  }

  state.readOnlyDepth -= 1;
  if (state.readOnlyDepth > 0) {
    return;
  }

  try {
    db.exec(`PRAGMA query_only = ${state.queryOnlyBefore === 1 ? 'ON' : 'OFF'}`);
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
  const tx = handleFor(db, 'read', isActive) as ReadTx;

  try {
    if (!joined) {
      db.exec('BEGIN DEFERRED');
    }

    const result = assertSynchronous(fn(tx), operation);

    if (!joined) {
      db.exec('COMMIT');
    }

    return result as NotPromise<T>;
  } catch (error) {
    if (!joined) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // See withWrite.
      }
    }
    throw classifyDatabaseError(error, operation);
  } finally {
    // Restore the guard before releasing the mode: a failure poisons the store
    // and must never mask the error that is already propagating.
    endReadGuard(store, db);

    if (!joined) {
      state.mode = 'idle';
    }
  }
}
