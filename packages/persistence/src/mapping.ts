/**
 * Field mapping: camelCase (API) ⇄ snake_case (database).
 *
 * Mechanical by design (DATA-MODEL §1): a single rule, no per-field exceptions,
 * so the mapping can be inferred and tested rather than remembered. Invalid
 * names throw instead of being "repaired" — a silent fix would hide a typo in a
 * column reference.
 *
 * This module never builds SQL. Repositories bind parameters against fixed
 * statements; mapping only converts names and the shapes of JSON/boolean column
 * values.
 */

import { PersistenceError } from './errors.js';

const CAMEL_CASE_NAME = /^[a-z][a-zA-Z0-9]*$/;
const SNAKE_CASE_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** `personaId` → `persona_id`. */
export function toSnakeCase(field: string): string {
  if (!CAMEL_CASE_NAME.test(field)) {
    throw new PersistenceError('invalid_field_name', 'field name is not lower camelCase', {
      details: { field },
    });
  }
  return field.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

/** `persona_id` → `personaId`. */
export function toCamelCase(column: string): string {
  if (!SNAKE_CASE_NAME.test(column)) {
    throw new PersistenceError('invalid_field_name', 'column name is not snake_case', {
      details: { column },
    });
  }
  const [head, ...rest] = column.split('_');
  return (
    (head as string) + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  );
}

/** True when the two names are the mechanical counterparts of each other. */
export function isMappedPair(camel: string, snake: string): boolean {
  try {
    return toSnakeCase(camel) === snake && toCamelCase(snake) === camel;
  } catch {
    return false;
  }
}

/**
 * Converts the keys of one database row to camelCase.
 *
 * Values are passed through untouched — including `null`. Converting values
 * here would be an implicit cast, and null is meaningful data, not "missing".
 */
export function camelizeRow<TRow extends Record<string, unknown>>(
  row: Readonly<Record<string, unknown>>,
): TRow {
  const mapped: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    mapped[toCamelCase(column)] = value;
  }
  return mapped as TRow;
}

/** SQLite stores booleans as INTEGER 0/1 (DATA-MODEL §1). */
export function toDbBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Reads a strict 0/1 INTEGER; anything else is a corruption, not a guess. */
export function fromDbBoolean(column: string, value: unknown): boolean {
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  throw new PersistenceError('invalid_column_value', 'boolean column is not 0 or 1', {
    details: { column, valueType: value === null ? 'null' : typeof value },
  });
}

/** Key that carries the shape version inside every JSON column. */
export const JSON_COLUMN_SCHEMA_KEY = 'schema';

/**
 * Serializes a JSON column value with its shape version (DATA-MODEL §1).
 *
 * The `schema` key is reserved: a payload that already carries one is rejected,
 * so a caller cannot claim a different shape version than the one this column
 * actually stores.
 */
export function encodeJsonColumn(
  schemaId: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (schemaId.trim().length === 0) {
    throw new PersistenceError('invalid_json_column', 'json column schema id is empty');
  }
  if (Object.hasOwn(payload, JSON_COLUMN_SCHEMA_KEY)) {
    throw new PersistenceError(
      'invalid_json_column',
      'json column payload must not carry a schema key of its own',
    );
  }
  return JSON.stringify({ [JSON_COLUMN_SCHEMA_KEY]: schemaId, ...payload });
}

/**
 * Parses a JSON column and verifies its shape version.
 *
 * Returns the payload without the `schema` marker; a null column stays null at
 * the call site (repositories decide, this function never invents a value).
 */
export function decodeJsonColumn<TValue extends Record<string, unknown>>(
  column: string,
  schemaId: string,
  text: string,
): TValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PersistenceError('invalid_json_column', 'json column is not valid JSON', {
      cause: error,
      details: { column },
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PersistenceError('invalid_json_column', 'json column is not a JSON object', {
      details: { column },
    });
  }

  const record = parsed as Record<string, unknown>;
  if (record[JSON_COLUMN_SCHEMA_KEY] !== schemaId) {
    throw new PersistenceError('invalid_json_column', 'json column has an unexpected schema id', {
      details: { column, expected: schemaId },
    });
  }

  const { [JSON_COLUMN_SCHEMA_KEY]: _ignored, ...payload } = record;
  return payload as TValue;
}
