/**
 * Archive `append` — request and response schemas, defined separately.
 *
 * The request is the one archive call that carries the original body: the
 * Archive Writer cannot encrypt what it never receives. The response carries a
 * result code and, when archived, the opaque `archiveRef` — never content,
 * never a fingerprint, never a byte length.
 */

import { RETENTION_CLASSES } from '../events/enums.js';
import { ERROR_CODES } from '../errors/codes.js';
import { ARCHIVE_REF_PATTERN, EVENT_ID_PATTERN, PERSONA_ID_PATTERN, SOURCE_PATTERN } from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

export const archiveAppendRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.append.request.v1',
  title: 'Archive append request',
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'personaId', 'source', 'receivedAt', 'retentionClass', 'body'],
  properties: {
    eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
    personaId: { type: 'string', pattern: PERSONA_ID_PATTERN },
    source: { type: 'string', pattern: SOURCE_PATTERN },
    receivedAt: { type: 'integer', minimum: 0 },
    occurredAt: { type: 'integer', minimum: 0 },
    retentionClass: { enum: [...RETENTION_CLASSES] },
    // Content-bearing field. Presence is required; emptiness is allowed.
    body: { type: 'string' },
  },
} as const satisfies JsonSchema;

export const archiveAppendResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.append.response.v1',
  title: 'Archive append response',
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: { enum: ['archived', 'duplicate', 'conflict', 'error'] },
    archiveRef: { type: 'string', pattern: ARCHIVE_REF_PATTERN },
    errorCode: { enum: [...ERROR_CODES] },
  },
  allOf: [
    {
      // A handle exists exactly when the record was archived.
      if: { properties: { result: { enum: ['archived', 'duplicate'] } }, required: ['result'] },
      then: {
        properties: { archiveRef: { type: 'string', pattern: ARCHIVE_REF_PATTERN } },
        required: ['archiveRef'],
      },
    },
    {
      if: { properties: { result: { enum: ['conflict', 'error'] } }, required: ['result'] },
      then: { properties: { archiveRef: false } },
    },
  ],
} as const satisfies JsonSchema;
