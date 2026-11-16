/**
 * Event-lifecycle enums.
 *
 * Every value here is a wire value: it appears in JSON payloads and in database
 * columns. The arrays are exported so tests (and future migrations) can assert
 * completeness instead of duplicating the lists.
 *
 * `status` and `archiveState` are two independent dimensions
 * (DATA-MODEL §3.4). Never derive one from the other.
 */

/** Persisted pipeline stage of one event. */
export const EVENT_STATUSES = [
  'received',
  'accepted',
  'noticed',
  'understood',
  'response_committed',
  'acted',
  'rejected',
  'expired',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Single attention verdict. Not an event terminal state. */
export const ATTENTION_OUTCOMES = [
  'not_evaluated',
  'ignored',
  'queued',
  'partially_aware',
  'fully_aware',
  'forced_control',
] as const;

export type AttentionOutcome = (typeof ATTENTION_OUTCOMES)[number];

/** How far the archive write for this event has progressed (events side). */
export const ARCHIVE_STATES = ['none', 'pending', 'archived', 'failed', 'excluded'] as const;

export type ArchiveState = (typeof ARCHIVE_STATES)[number];

/**
 * What the Archive Writer reports for one `eventId`.
 * Deliberately narrower than `ArchiveState`: `none` / `excluded` are events-side
 * bookkeeping and can never be observed from the archive domain.
 */
export const ARCHIVE_WRITER_STATES = ['archived', 'failed', 'not_found'] as const;

export type ArchiveWriterState = (typeof ARCHIVE_WRITER_STATES)[number];

/** Deterministic archive-scope decision. Models never produce this value. */
export const ARCHIVE_DISPOSITIONS = ['required', 'excluded'] as const;

export type ArchiveDisposition = (typeof ARCHIVE_DISPOSITIONS)[number];

/** Finite retention bucket; every archived record needs exactly one. */
export const RETENTION_CLASSES = ['standard', 'restricted', 'short_lived'] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Task / thread channel. */
export const CHANNELS = ['external', 'inner', 'sleep', 'dream', 'audit'] as const;

export type Channel = (typeof CHANNELS)[number];

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === 'string' && (EVENT_STATUSES as readonly string[]).includes(value);
}

export function isAttentionOutcome(value: unknown): value is AttentionOutcome {
  return typeof value === 'string' && (ATTENTION_OUTCOMES as readonly string[]).includes(value);
}

export function isArchiveState(value: unknown): value is ArchiveState {
  return typeof value === 'string' && (ARCHIVE_STATES as readonly string[]).includes(value);
}

export function isArchiveWriterState(value: unknown): value is ArchiveWriterState {
  return typeof value === 'string' && (ARCHIVE_WRITER_STATES as readonly string[]).includes(value);
}

export function isArchiveDisposition(value: unknown): value is ArchiveDisposition {
  return typeof value === 'string' && (ARCHIVE_DISPOSITIONS as readonly string[]).includes(value);
}

export function isRetentionClass(value: unknown): value is RetentionClass {
  return typeof value === 'string' && (RETENTION_CLASSES as readonly string[]).includes(value);
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}
