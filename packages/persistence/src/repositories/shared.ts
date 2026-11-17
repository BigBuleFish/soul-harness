/**
 * Small helpers shared by the repositories.
 *
 * Kept deliberately tiny: repositories bind parameters against fixed SQL, so the
 * only shared concerns are argument validation and the two JSON columns that
 * carry a shape version.
 */

import type { JsonObject } from '@soul-harness/contracts';

import { PersistenceError } from '../errors.js';
import { decodeJsonColumn, encodeJsonColumn } from '../mapping.js';

/** Default page size for list queries; keeps an accidental full scan impossible. */
export const DEFAULT_LIST_LIMIT = 50;

/** Hard ceiling for list queries. */
export const MAX_LIST_LIMIT = 500;

export function assertLimit(
  limit: number | undefined,
  fallback: number = DEFAULT_LIST_LIMIT,
): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new PersistenceError(
      'invalid_argument',
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      { details: { limit: String(value) } },
    );
  }
  return value;
}

/** Shape versions carried by the P1 JSON columns. */
export const JSON_SCHEMA_IDS = {
  sessionMeta: 'soul.sessions.meta.v1',
  taskPayload: 'soul.tasks.payload.v1',
} as const;

export function encodeOptionalJson(
  schemaId: string,
  payload: JsonObject | undefined | null,
): string | null {
  if (payload === undefined || payload === null) {
    return null;
  }
  return encodeJsonColumn(schemaId, payload);
}

export function decodeOptionalJson(
  column: string,
  schemaId: string,
  text: unknown,
): JsonObject | null {
  if (text === null) {
    return null;
  }
  if (typeof text !== 'string') {
    throw new PersistenceError('invalid_json_column', 'json column is not text', {
      details: { column },
    });
  }
  return decodeJsonColumn<JsonObject>(column, schemaId, text);
}
