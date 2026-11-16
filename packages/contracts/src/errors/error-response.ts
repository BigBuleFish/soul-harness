/**
 * Error response — the only shape an immediate failure may take.
 *
 * `message` is pinned to the canonical catalog in `ERROR_MESSAGES`; it is never
 * built from an exception, a stack frame or any part of the stimulus. That
 * removes the one field where "just add the reason string" would otherwise
 * smuggle content into a response.
 */

import type { ErrorCode } from './codes.js';
import type { EventId } from '../ids/types.js';

export interface ErrorBody {
  readonly code: ErrorCode;
  /** Canonical text for `code`; see `ERROR_MESSAGES`. Never interpolated. */
  readonly message: string;
  /** Present only when the event identity had already been allocated. */
  readonly eventId?: EventId;
}

export interface ErrorResponse {
  readonly error: ErrorBody;
}
