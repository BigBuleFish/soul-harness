/**
 * Typed row access.
 *
 * `node:sqlite` returns `Record<string, SQLOutputValue>`, which is deliberately
 * untyped. Every caller in this package knows the shape of its own query, so the
 * single, explicit cast lives here instead of being sprinkled — and repeated —
 * at each call site.
 */

import type { SQLInputValue, StatementSync } from 'node:sqlite';

/** Runs a query and returns the rows as `T[]`. */
export function allRows<T>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as unknown as T[];
}

/** Runs a query and returns the first row as `T | undefined`. */
export function oneRow<T>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined;
}
