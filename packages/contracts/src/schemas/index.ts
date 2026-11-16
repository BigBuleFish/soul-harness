/**
 * Schema registry.
 *
 * One key per wire message, keyed by `$id`. Consumers (Ingress, Archive Writer,
 * adapter SDK, tests) should pull schemas from here rather than importing
 * individual modules, so that "which messages exist" has exactly one answer.
 *
 * `soul.stimulus.input.v1` is the only stimulus schema an external caller may
 * validate against; `soul.stimulus.v1` is the internal normalized form.
 */

import { ackResponseSchema } from './ack.js';
import { archiveAppendRequestSchema, archiveAppendResponseSchema } from './archive-append.js';
import { archiveCompareRequestSchema, archiveCompareResponseSchema } from './archive-compare.js';
import { archiveStatusRequestSchema, archiveStatusResponseSchema } from './archive-status.js';
import { errorResponseSchema } from './error.js';
import { stimulusInputV1Schema, stimulusV1Schema } from './stimulus.js';
import type { JsonSchema } from './types.js';

export const SCHEMA_IDS = [
  'soul.stimulus.input.v1',
  'soul.stimulus.v1',
  'soul.ack.v1',
  'soul.error.v1',
  'soul.archive.append.request.v1',
  'soul.archive.append.response.v1',
  'soul.archive.status.request.v1',
  'soul.archive.status.response.v1',
  'soul.archive.compare.request.v1',
  'soul.archive.compare.response.v1',
] as const;

export type SchemaId = (typeof SCHEMA_IDS)[number];

export const SCHEMAS: Readonly<Record<SchemaId, JsonSchema>> = {
  'soul.stimulus.input.v1': stimulusInputV1Schema,
  'soul.stimulus.v1': stimulusV1Schema,
  'soul.ack.v1': ackResponseSchema,
  'soul.error.v1': errorResponseSchema,
  'soul.archive.append.request.v1': archiveAppendRequestSchema,
  'soul.archive.append.response.v1': archiveAppendResponseSchema,
  'soul.archive.status.request.v1': archiveStatusRequestSchema,
  'soul.archive.status.response.v1': archiveStatusResponseSchema,
  'soul.archive.compare.request.v1': archiveCompareRequestSchema,
  'soul.archive.compare.response.v1': archiveCompareResponseSchema,
};

export type { JsonSchema } from './types.js';
export { stimulusInputV1Schema, stimulusV1Schema } from './stimulus.js';
export { ackResponseSchema } from './ack.js';
export { errorResponseSchema, ERROR_MESSAGE_MAX_LENGTH } from './error.js';
export { archiveAppendRequestSchema, archiveAppendResponseSchema } from './archive-append.js';
export { archiveStatusRequestSchema, archiveStatusResponseSchema } from './archive-status.js';
export { archiveCompareRequestSchema, archiveCompareResponseSchema } from './archive-compare.js';
