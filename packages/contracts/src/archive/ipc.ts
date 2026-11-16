/**
 * Archive Writer IPC — three interfaces, each with its own request and response.
 *
 * TRUST-BOUNDARIES §5.4/§5.5 fixes the boundary; this file is the wire shape.
 *
 * Invariants encoded here:
 *   - Requests MAY carry body content: `append` carries the original that is
 *     about to be archived, `compare` carries the candidate body to test.
 *   - Responses NEVER carry content: no plaintext, no ciphertext, no
 *     fingerprint, no byte length, no key material.
 *   - The three interfaces are NOT interchangeable: they have separate request
 *     and response types, and there is no shared "generic archive result".
 *   - `compare` answers a single question and returns exactly one of three
 *     verdicts. It never returns the compared content or any derivative.
 *   - `append` responses are a discriminated union: each result code has exactly
 *     one legal field set, so `{result:'archived'}` without a handle, or
 *     `{result:'error'}` without a code, cannot be represented in TypeScript.
 */

import type {
  AdapterId,
  ArchiveRef,
  EventId,
  PersonaId,
  RequestNonce,
  SourceId,
} from '../ids/types.js';
import type { ArchiveWriterState, RetentionClass } from '../events/enums.js';
import type { ErrorCode } from '../errors/codes.js';

/* -------------------------------------------------------------------------- */
/* append                                                                     */
/* -------------------------------------------------------------------------- */

/** Request: archive one original. The body is the only content-bearing field. */
export interface ArchiveAppendRequest {
  readonly eventId: EventId;
  readonly personaId: PersonaId;
  readonly source: SourceId;
  /** Unix ms; the archive record keeps the same value. */
  readonly receivedAt: number;
  readonly occurredAt?: number;
  /** Finite retention bucket; a missing bucket must fail, never default. */
  readonly retentionClass: RetentionClass;
  /**
   * The original, serialized exactly as it was fingerprinted during ingress.
   * The archive domain encrypts it and never returns it.
   */
  readonly body: string;
}

export const ARCHIVE_APPEND_RESULTS = ['archived', 'duplicate', 'conflict', 'error'] as const;

export type ArchiveAppendResult = (typeof ARCHIVE_APPEND_RESULTS)[number];

/** Freshly written. A handle exists and no error code may accompany it. */
export interface ArchiveAppendArchived {
  readonly result: 'archived';
  readonly archiveRef: ArchiveRef;
}

/** Already present with identical content. Same shape as `archived` by design. */
export interface ArchiveAppendDuplicate {
  readonly result: 'duplicate';
  readonly archiveRef: ArchiveRef;
}

/** Same event id, different content. No handle, no error code. */
export interface ArchiveAppendConflict {
  readonly result: 'conflict';
}

/** Transport or storage failure. A controlled code is mandatory. */
export interface ArchiveAppendError {
  readonly result: 'error';
  readonly errorCode: ErrorCode;
}

/**
 * Response: exactly one of four shapes.
 *
 * Pairing rules (also enforced by the JSON Schema `oneOf`):
 *   archived  → archiveRef required, errorCode forbidden
 *   duplicate → archiveRef required, errorCode forbidden
 *   conflict  → neither field allowed
 *   error     → errorCode required, archiveRef forbidden
 */
export type ArchiveAppendResponse =
  | ArchiveAppendArchived
  | ArchiveAppendDuplicate
  | ArchiveAppendConflict
  | ArchiveAppendError;

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Request: correlation only.
 *
 * `personaId` is intentionally NOT part of this request (unlike `compare`):
 * the response carries no content, and `eventId` is unique deployment-wide, so
 * there is nothing an extra scope check would protect.
 */
export interface ArchiveStatusRequest {
  readonly eventId: EventId;
}

/** Response: exactly the three fields recovery is allowed to see. */
export interface ArchiveStatusResponse {
  readonly eventId: EventId;
  readonly archiveState: ArchiveWriterState;
  /** `null` unless `archiveState` is `archived`. */
  readonly archiveRef: ArchiveRef | null;
}

/* -------------------------------------------------------------------------- */
/* compare                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Request: equality check for one dedupe hit.
 *
 * The five identity fields bind this call to one delivery of one event
 * (TRUST-BOUNDARIES §5.5). `candidateBody` is the only content-bearing field.
 */
export interface ArchiveCompareRequest {
  readonly eventId: EventId;
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly source: SourceId;
  readonly requestNonce: RequestNonce;
  /** Serialized with the same encoder used for `append`, or the HMAC differs. */
  readonly candidateBody: string;
}

export const ARCHIVE_COMPARE_RESULTS = ['match', 'conflict', 'not_found'] as const;

export type ArchiveCompareResult = (typeof ARCHIVE_COMPARE_RESULTS)[number];

/**
 * Response: the verdict, and nothing else.
 *
 * No `eventId` echo, no fingerprint, no length — the request already identifies
 * the event, and any extra field would be a place for a content oracle to grow.
 */
export interface ArchiveCompareResponse {
  readonly result: ArchiveCompareResult;
}
