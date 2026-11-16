/**
 * Error response — JSON Schema.
 *
 * Two constraints are load-bearing here:
 *   1. `code` comes from `ERROR_CODES` only, so a `StatusReason` such as
 *      `buffer_lost` is rejected: terminal reasons belong to the status query.
 *   2. `message` is pinned to the canonical text for that code via a `oneOf`
 *      over the catalog, so an implementation cannot interpolate an exception,
 *      a stack frame, a path or a fragment of the stimulus into the response.
 *
 * The per-code branches are closed objects, so unknown fields fail as well.
 */

import { ERROR_CODES, ERROR_MESSAGES } from '../errors/codes.js';
import { EVENT_ID_PATTERN } from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

/** Kept for documentation; the catalog itself is the actual upper bound. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

const branch = (code: (typeof ERROR_CODES)[number]) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: {
      code: { const: code },
      message: { const: ERROR_MESSAGES[code] },
      eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
    },
  }) as const;

export const errorResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.error.v1',
  title: 'Error response',
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      oneOf: ERROR_CODES.map(branch),
    },
  },
} as const satisfies JsonSchema;
