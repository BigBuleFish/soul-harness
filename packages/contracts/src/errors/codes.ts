/**
 * Transport-level error codes.
 *
 * Scope: what an adapter sees in an `ErrorResponse` for the *current call*.
 * This is NOT `StatusReason`: an event's later terminal state and its reason are
 * queried separately and never ride on an ACK (see `AckResponse`).
 *
 * Three codes here have no `StatusReason` counterpart (`compare_limited`,
 * `internal_error`) and one status reason has no error-code counterpart
 * (`buffer_lost`); tests assert that the two sets stay distinct.
 */

export const ERROR_CODES = [
  'auth_failed',
  'untrusted_source',
  'schema_invalid',
  'rate_limited',
  'archive_unavailable',
  'archive_conflict',
  'processing_failed',
  'compare_limited',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * HTTP status each code maps to. Fixed at the contract level so adapters can
 * implement retry/backoff without guessing.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  auth_failed: 401,
  untrusted_source: 403,
  schema_invalid: 400,
  rate_limited: 429,
  archive_unavailable: 503,
  archive_conflict: 409,
  processing_failed: 500,
  compare_limited: 429,
  internal_error: 500,
};

/** Codes an adapter may retry the *same delivery* on. */
export const RETRYABLE_ERROR_CODES = ['rate_limited', 'archive_unavailable', 'compare_limited'] as const;

export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isRetryableErrorCode(value: unknown): value is RetryableErrorCode {
  return typeof value === 'string' && (RETRYABLE_ERROR_CODES as readonly string[]).includes(value);
}
