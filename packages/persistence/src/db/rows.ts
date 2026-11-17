/**
 * Typed row access.
 *
 * `node:sqlite` returns `Record<string, SQLOutputValue>`, which is deliberately
 * untyped. Every caller in this package knows the shape of its own query, so the
 * single, explicit cast lives here instead of being sprinkled — and repeated —
 * at each call site.
 *
 * The structural `QueryStatement` / `StatementSource` types below let the same
 * helpers accept either a raw driver statement (repositories reading directly)
 * or a transaction-guarded statement (writes inside `withWrite`), without ever
 * naming the driver type in a public signature.
 */

import type { SQLInputValue } from 'node:sqlite';

export interface StatementRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** The subset of a prepared statement the repositories rely on. */
export interface QueryStatement {
  run(...params: SQLInputValue[]): StatementRunResult;
  get(...params: SQLInputValue[]): unknown;
  all(...params: SQLInputValue[]): unknown;
}

/** Anything that can prepare statements: a live database or a transaction handle. */
export interface StatementSource {
  prepare(sql: string): QueryStatement;
}

interface RowListSource {
  all(...params: SQLInputValue[]): unknown;
}

interface RowSource {
  get(...params: SQLInputValue[]): unknown;
}

/** Runs a query and returns the rows as `T[]`. */
export function allRows<T>(statement: RowListSource, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as unknown as T[];
}

/** Runs a query and returns the first row as `T | undefined`. */
export function oneRow<T>(statement: RowSource, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined;
}
