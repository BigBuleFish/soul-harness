/**
 * ACK response.
 *
 * Deliberately minimal (SH-004 decision B3): a successful call returns the
 * event identity and its lifecycle status — nothing else. In particular:
 *   - `statusReason` never rides on an ACK. An `accepted` ACK must not carry a
 *     reason code, and an event that later terminates is observed through the
 *     status query, not by re-reading an ACK.
 *   - Immediate failures are not ACKs at all; they are `ErrorResponse`.
 *
 * The JSON Schema (see `src/schemas/ack.ts`) sets `additionalProperties: false`,
 * so adding `statusReason` here is a schema violation rather than a convention.
 */

import type { EventId } from './ids/types.js';
import type { EventStatus } from './events/enums.js';

export interface AckResponse {
  /** Identity of the event this delivery maps to (newly created or existing). */
  readonly eventId: EventId;
  /** Lifecycle status after the call. `accepted` is the common success case. */
  readonly status: EventStatus;
}
