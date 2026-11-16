/**
 * Shared ajv helper for the schema tests.
 *
 * The tests exercise the real validator: schemas are compiled by ajv and the
 * fixtures are checked against the compiled function. Nothing is mocked, and no
 * assertion is derived from the TypeScript types alone.
 */

import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';

import { SCHEMAS, type SchemaId } from '../../src/schemas/index.js';

export const ajv = new Ajv({ allErrors: true, strict: true });

export function validatorFor(id: SchemaId): ValidateFunction {
  const compiled = ajv.getSchema(id);
  if (compiled) {
    return compiled;
  }
  return ajv.compile(SCHEMAS[id] as Record<string, unknown>);
}

export function isValid(id: SchemaId, doc: unknown): boolean {
  return validatorFor(id)(doc) === true;
}

/** Keyword + instance path list, for asserting *why* a document was rejected. */
export function errorsFor(id: SchemaId, doc: unknown): string[] {
  const validate = validatorFor(id);
  validate(doc);
  return (validate.errors ?? []).map((error) => `${error.keyword}${error.instancePath}`);
}
