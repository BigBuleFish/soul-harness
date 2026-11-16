/**
 * Stimulus envelope v1 — JSON Schema.
 *
 * Enforcement split (SH-004 decision B2):
 *   - Envelope top level is CLOSED: `additionalProperties: false`. An unknown
 *     top-level key is a `schema_invalid` failure, never silently ignored.
 *   - `payload` is the designated extension area and is OPEN
 *     (`additionalProperties: true`), with two required discriminators.
 *
 * This split is what makes forward-compatible payloads possible without
 * weakening the envelope: an adapter cannot smuggle `personaId`, `adapterId` or
 * `requestNonce` behaviour through extra top-level keys, and the core never
 * reads identity out of `payload`.
 */

import {
  ADAPTER_EVENT_REF_PATTERN,
  ADAPTER_ID_PATTERN,
  PAYLOAD_KIND_PATTERN,
  PERSONA_ID_PATTERN,
  REQUEST_NONCE_PATTERN,
  SOURCE_PATTERN,
} from '../ids/patterns.js';
import { PROTOCOL_VERSION } from '../version.js';
import type { JsonSchema } from './types.js';

export const stimulusV1Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.stimulus.v1',
  title: 'Stimulus envelope v1',
  description:
    'One external stimulus entering the Harness. Top-level fields are closed; payload is the open extension area.',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema',
    'personaId',
    'adapterId',
    'source',
    'adapterEventRef',
    'requestNonce',
    'receivedAt',
    'payload',
  ],
  properties: {
    schema: { const: PROTOCOL_VERSION },
    personaId: { type: 'string', pattern: PERSONA_ID_PATTERN },
    adapterId: { type: 'string', pattern: ADAPTER_ID_PATTERN },
    source: { type: 'string', pattern: SOURCE_PATTERN },
    adapterEventRef: { type: 'string', pattern: ADAPTER_EVENT_REF_PATTERN },
    requestNonce: { type: 'string', pattern: REQUEST_NONCE_PATTERN },
    receivedAt: { type: 'integer', minimum: 0 },
    occurredAt: { type: 'integer', minimum: 0 },
    payload: {
      type: 'object',
      // The only open area in the whole protocol.
      additionalProperties: true,
      required: ['kind', 'version'],
      properties: {
        kind: { type: 'string', pattern: PAYLOAD_KIND_PATTERN },
        version: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const satisfies JsonSchema;
