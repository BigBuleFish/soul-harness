/**
 * Archive `status` — request and response schemas, defined separately.
 *
 * The response is the narrowest surface in the whole system: three fields, all
 * of which are allowed to cross the Brain boundary (TRUST-BOUNDARIES §5.4).
 * `archiveRef` is null unless the record is actually archived; that pairing is
 * enforced here so the runtime cannot persist a ref for a failed record.
 */

import { ARCHIVE_WRITER_STATES } from '../events/enums.js';
import { ARCHIVE_REF_PATTERN, EVENT_ID_PATTERN } from '../ids/patterns.js';
import type { JsonSchema } from './types.js';

export const archiveStatusRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.status.request.v1',
  title: 'Archive status request',
  type: 'object',
  additionalProperties: false,
  required: ['eventId'],
  properties: {
    eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
  },
} as const satisfies JsonSchema;

export const archiveStatusResponseSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'soul.archive.status.response.v1',
  title: 'Archive status response',
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'archiveState', 'archiveRef'],
  properties: {
    eventId: { type: 'string', pattern: EVENT_ID_PATTERN },
    archiveState: { enum: [...ARCHIVE_WRITER_STATES] },
    archiveRef: {
      anyOf: [{ type: 'string', pattern: ARCHIVE_REF_PATTERN }, { type: 'null' }],
    },
  },
  allOf: [
    {
      // A handle exists only when the record is actually archived.
      if: { properties: { archiveState: { enum: ['failed', 'not_found'] } }, required: ['archiveState'] },
      then: { properties: { archiveRef: { type: 'null' } } },
    },
    {
      if: { properties: { archiveState: { const: 'archived' } }, required: ['archiveState'] },
      then: { properties: { archiveRef: { type: 'string', pattern: ARCHIVE_REF_PATTERN } } },
    },
  ],
} as const satisfies JsonSchema;
