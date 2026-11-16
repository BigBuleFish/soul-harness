/**
 * Stimulus JSON Schemas — two documents for two layers.
 *
 *   soul.stimulus.input.v1  — adapter-submitted; NO `receivedAt`
 *   soul.stimulus.v1        — normalized by Ingress; `receivedAt` required
 *
 * Both close the top level (`additionalProperties: false`), so an adapter that
 * tries to set `receivedAt` is rejected as `schema_invalid` rather than having
 * its value silently trusted or overwritten. `payload` remains the single open
 * extension area in both.
 *
 * `occurredAt`, when present, is a source-claimed timestamp. It is validated as
 * an integer but carries no authority: Skew and absence are both expected.
 */

import {
  ADAPTER_EVENT_REF_PATTERN,
  ADAPTER_ID_PATTERN,
  PAYLOAD_KIND_PATTERN,
  PERSONA_ID_PATTERN,
  REQUEST_NONCE_PATTERN,
  SOURCE_PATTERN,
} from '../ids/patterns.js';
import { STIMULUS_INPUT_VERSION, STIMULUS_VERSION } from '../version.js';
import type { JsonSchema } from './types.js';

/** Fields shared by both envelopes; `receivedAt`/`schema` are added per layer. */
const COMMON_PROPERTIES = {
  personaId: { type: 'string', pattern: PERSONA_ID_PATTERN },
  adapterId: { type: 'string', pattern: ADAPTER_ID_PATTERN },
  source: { type: 'string', pattern: SOURCE_PATTERN },
  adapterEventRef: { type: 'string', pattern: ADAPTER_EVENT_REF_PATTERN },
  requestNonce: { type: 'string', pattern: REQUEST_NONCE_PATTERN },
  // Source-claimed, not authoritative; optional.
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
} as const;

const COMMON_REQUIRED = [
  'schema',
  'personaId',
  'adapterId',
  'source',
  'adapterEventRef',
  'requestNonce',
  'payload',
] as const;

/**
 * Adapter-submitted envelope.
 * `receivedAt` is absent by construction: the property is not declared and the
 * object is closed, so submitting it fails validation.
 */
export const stimulusInputV1Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.stimulus.input.v1',
  title: 'Stimulus input envelope v1 (adapter → Ingress)',
  description:
    'The only envelope an external caller may submit. No receivedAt: receipt time is assigned by Ingress.',
  type: 'object',
  additionalProperties: false,
  required: [...COMMON_REQUIRED],
  properties: {
    schema: { const: STIMULUS_INPUT_VERSION },
    ...COMMON_PROPERTIES,
  },
} as const satisfies JsonSchema;

/**
 * Normalized envelope (Ingress → Runtime).
 *
 * Never accepted from an adapter: Ingress is the only producer, and it is the
 * only component allowed to stamp `receivedAt`.
 */
export const stimulusV1Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.stimulus.v1',
  title: 'Stimulus envelope v1 (Ingress → Runtime)',
  description:
    'Normalized envelope produced inside the trusted receive path. receivedAt is Ingress-owned and required.',
  type: 'object',
  additionalProperties: false,
  required: [...COMMON_REQUIRED, 'receivedAt'],
  properties: {
    schema: { const: STIMULUS_VERSION },
    ...COMMON_PROPERTIES,
    receivedAt: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonSchema;
