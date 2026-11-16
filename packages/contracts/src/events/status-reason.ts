/**
 * Terminal reason codes for `expired` / `rejected` events.
 *
 * This is a *persistence* taxonomy: it is written to `events.status_reason` and
 * is deliberately disjoint from `ErrorCode`. `ErrorCode` answers "what did this
 * HTTP call fail with"; `StatusReason` answers "why is this event terminal".
 * They are separate types and separate value sets, with a documented overlap on
 * the rejection codes only.
 */

/** Reasons an event may become `expired`. */
export const EXPIRED_REASONS = ['buffer_lost', 'ttl_expired', 'queue_overflow'] as const;

export type ExpiredReason = (typeof EXPIRED_REASONS)[number];

/** Reasons an event may become `rejected`. */
export const REJECTED_REASONS = [
  'auth_failed',
  'untrusted_source',
  'schema_invalid',
  'rate_limited',
  'archive_unavailable',
  'archive_conflict',
  'processing_failed',
] as const;

export type RejectedReason = (typeof REJECTED_REASONS)[number];

/** Every legal `status_reason` value, in controlled-enum form. */
export const STATUS_REASONS = [...EXPIRED_REASONS, ...REJECTED_REASONS] as const;

export type StatusReason = ExpiredReason | RejectedReason;

export function isExpiredReason(value: unknown): value is ExpiredReason {
  return typeof value === 'string' && (EXPIRED_REASONS as readonly string[]).includes(value);
}

export function isRejectedReason(value: unknown): value is RejectedReason {
  return typeof value === 'string' && (REJECTED_REASONS as readonly string[]).includes(value);
}

export function isStatusReason(value: unknown): value is StatusReason {
  return isExpiredReason(value) || isRejectedReason(value);
}

/** Statuses that carry no reason code; their `status_reason` must be null. */
export const NON_TERMINAL_EVENT_STATUSES = [
  'received',
  'accepted',
  'noticed',
  'understood',
  'response_committed',
  'acted',
] as const;

export type NonTerminalEventStatus = (typeof NON_TERMINAL_EVENT_STATUSES)[number];

/**
 * Type-level encoding of the database CHECK constraint that pairs status with
 * reason. Using a discriminated union makes "reason without terminal status"
 * (or the reverse) unrepresentable in typed code; the JSON Schemas under
 * `src/schemas/` enforce the same rule at the wire boundary.
 */
export type EventStatusWithReason =
  | { readonly status: 'expired'; readonly statusReason: ExpiredReason }
  | { readonly status: 'rejected'; readonly statusReason: RejectedReason }
  | { readonly status: NonTerminalEventStatus; readonly statusReason: null };
