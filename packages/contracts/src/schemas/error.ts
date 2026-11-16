/**
 * Error response — JSON Schema.
 *
 * `code` is enumerated from `ERROR_CODES` only. A `StatusReason` value such as
 * `buffer_lost` is therefore rejected here: terminal reasons are reported by the
 * status query, not by the call that failed.
 */

import { ERROR_CODES } from '../errors/codes.js';
import { EVENT_ID_PATTERN } from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

/** Upper bound for the fixed description; keeps accidental content out. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

export const errorResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.error.v1',
  title: 'Error response',
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { enum: [...ERROR_CODES] },
        message: { type: 'string', minLength: 1, maxLength: ERROR_MESSAGE_MAX_LENGTH },
        eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
      },
    },
  },
} as const satisfies JsonSchema;
