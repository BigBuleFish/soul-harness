/**
 * Error response — the only shape an immediate failure may take.
 *
 * Rules inherited from the architecture docs:
 *   - `code` is a controlled enum; no free text, no exception text, no payload
 *     fragments (TRUST-BOUNDARIES §6, DATA-MODEL §3.1).
 *   - `message` is a fixed short human-readable description, capped in length.
 *     It must never echo stimulus content, and it is never shown to the model.
 *   - `eventId` is included only when an identity was already allocated.
 *   - An event's terminal reason is NOT reported here; it belongs to the status
 *     query (`StatusReason`), keeping ACK and status responsibilities apart.
 */

import type { ErrorCode } from './codes.js';
import type { EventId } from '../ids/types.js';

export interface ErrorBody {
  readonly code: ErrorCode;
  /** Fixed short description; never contains stimulus content. */
  readonly message: string;
  /** Present only when the event identity had already been allocated. */
  readonly eventId?: EventId;
}

export interface ErrorResponse {
  readonly error: ErrorBody;
}
