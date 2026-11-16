/**
 * Archive `compare` — request and response schemas, defined separately.
 *
 * This is the most constrained interface in the system (TRUST-BOUNDARIES §5.5):
 *   - The request binds the check to one event AND one delivery: `eventId` plus
 *     `personaId`/`adapterId`/`source`/`requestNonce`. Without those, `compare`
 *     would degrade into a content oracle an internal caller could probe.
 *   - The response is a bare three-valued verdict. Not even the `eventId` is
 *     echoed: every extra field is a channel that could grow into something
 *     leaky later.
 */

import {
  ADAPTER_ID_PATTERN,
  EVENT_ID_PATTERN,
  PERSONA_ID_PATTERN,
  REQUEST_NONCE_PATTERN,
  SOURCE_PATTERN,
} from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

export const archiveCompareRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.compare.request.v1',
  title: 'Archive compare request',
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'personaId', 'adapterId', 'source', 'requestNonce', 'candidateBody'],
  properties: {
    eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
    personaId: { type: 'string', pattern: PERSONA_ID_PATTERN },
    adapterId: { type: 'string', pattern: ADAPTER_ID_PATTERN },
    source: { type: 'string', pattern: SOURCE_PATTERN },
    requestNonce: { type: 'string', pattern: REQUEST_NONCE_PATTERN },
    // Content-bearing field: the candidate whose equality is being tested.
    candidateBody: { type: 'string' },
  },
} as const satisfies JsonSchema;

export const archiveCompareResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.compare.response.v1',
  title: 'Archive compare response',
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { enum: ['match', 'conflict', 'not_found'] },
  },
} as const satisfies JsonSchema;
