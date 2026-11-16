/**
 * ACK response — JSON Schema.
 *
 * `additionalProperties: false` is load-bearing (decision B3): it makes
 * `statusReason` on an ACK a hard schema violation instead of a soft convention.
 * A successful call carries identity plus lifecycle status, nothing else.
 */

import { EVENT_STATUSES } from '../events/enums.js';
import { EVENT_ID_PATTERN } from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

export const ackResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.ack.v1',
  title: 'ACK response',
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'status'],
  properties: {
    eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
    status: { enum: [...EVENT_STATUSES] },
  },
} as const satisfies JsonSchema;
