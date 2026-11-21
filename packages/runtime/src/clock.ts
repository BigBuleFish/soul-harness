/**
 * Clock validation for the runtime.
 *
 * `now()` is caller-supplied and may be anything: a test double, a wall clock,
 * or a broken function. Every read is validated at the point of use so an
 * invalid timestamp can never reach the database or a timer calculation.
 */

import { RuntimeError } from './errors.js';

/** Largest value a non-negative safe integer timestamp may take. */
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

/**
 * Validates one clock reading: integer, safe, non-negative.
 *
 * Throws `invalid_clock`; never coerces, never clamps.
 */
export function assertClockValue(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeError('invalid_clock', 'now() must return a non-negative safe integer');
  }
}

/**
 * Calls `now()` once and validates the result.
 *
 * A throwing clock is reported as `invalid_clock` with the original error as
 * `cause`, so construction-time and run-time behavior are identical.
 */
export function readClock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch (error) {
    throw new RuntimeError('invalid_clock', 'now() threw', { cause: error });
  }
  assertClockValue(value);
  return value;
}
