import { describe, expect, it } from 'vitest';

import { SCHEMAS, SCHEMA_IDS, type SchemaId } from '../src/schemas/index.js';
import { ajv } from './helpers/validator.js';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

const RESPONSE_SCHEMAS: readonly SchemaId[] = [
  'soul.ack.v1',
  'soul.error.v1',
  'soul.archive.append.response.v1',
  'soul.archive.status.response.v1',
  'soul.archive.compare.response.v1',
];

/** Field names that must never appear inside an archive response. */
const FORBIDDEN_RESPONSE_FIELDS = [
  'body',
  'candidateBody',
  'content',
  'contentEnc',
  'content_enc',
  'ciphertext',
  'fingerprint',
  'contentFingerprint',
  'content_fingerprint',
  'byteLength',
  'byte_len',
  'length',
  'encKeyId',
  'enc_key_id',
  'macKeyId',
  'mac_key_id',
  'plaintext',
  'decrypted',
];

function collectPropertyNames(node: unknown, acc: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyNames(item, acc);
    }
    return acc;
  }
  if (node === null || typeof node !== 'object') {
    return acc;
  }
  const obj = node as Record<string, unknown>;
  const properties = obj['properties'];
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const name of Object.keys(properties as Record<string, unknown>)) {
      acc.add(name);
    }
  }
  for (const value of Object.values(obj)) {
    collectPropertyNames(value, acc);
  }
  return acc;
}

describe('JSON Schema meta-validity', () => {
  it('every registered schema is a valid draft-07 document', () => {
    for (const id of SCHEMA_IDS) {
      const valid = ajv.validateSchema(SCHEMAS[id] as Record<string, unknown>);
      expect(valid, `${id}: ${JSON.stringify(ajv.errors)}`).toBe(true);
    }
  });

  it('every schema declares draft-07 and an $id equal to its registry key', () => {
    for (const id of SCHEMA_IDS) {
      const schema = SCHEMAS[id];
      expect(schema['$schema']).toBe(DRAFT_07);
      expect(schema['$id']).toBe(id);
    }
  });

  it('every schema compiles with ajv strict mode', () => {
    for (const id of SCHEMA_IDS) {
      expect(() => ajv.compile(SCHEMAS[id] as Record<string, unknown>)).not.toThrow();
    }
  });

  it('closes the top level of every message', () => {
    for (const id of SCHEMA_IDS) {
      expect(SCHEMAS[id]['additionalProperties'], id).toBe(false);
    }
  });

  it('survives a JSON round-trip (they are real JSON documents)', () => {
    for (const id of SCHEMA_IDS) {
      const schema = SCHEMAS[id];
      const roundTripped: unknown = JSON.parse(JSON.stringify(schema));
      expect(roundTripped).toStrictEqual(schema);
    }
  });

  it('keeps the registry and the id list in sync', () => {
    expect(Object.keys(SCHEMAS).sort()).toStrictEqual([...SCHEMA_IDS].sort());
    expect(new Set(SCHEMA_IDS).size).toBe(SCHEMA_IDS.length);
    for (const id of SCHEMA_IDS) {
      expect(SCHEMAS[id]).toBeDefined();
    }
  });
});

describe('archive responses never expose content', () => {
  it.each(RESPONSE_SCHEMAS)('%s declares no content-bearing field', (id) => {
    const names = collectPropertyNames(SCHEMAS[id]);
    const leaked = [...names].filter((name) => FORBIDDEN_RESPONSE_FIELDS.includes(name));
    expect(leaked, `${id} leaks: ${leaked.join(', ')}`).toStrictEqual([]);
  });

  it('requests are allowed to carry the body, responses are not', () => {
    const appendRequestFields = collectPropertyNames(SCHEMAS['soul.archive.append.request.v1']);
    const compareRequestFields = collectPropertyNames(SCHEMAS['soul.archive.compare.request.v1']);

    expect(appendRequestFields.has('body')).toBe(true);
    expect(compareRequestFields.has('candidateBody')).toBe(true);

    expect(collectPropertyNames(SCHEMAS['soul.archive.append.response.v1']).has('body')).toBe(false);
    expect(
      collectPropertyNames(SCHEMAS['soul.archive.compare.response.v1']).has('candidateBody'),
    ).toBe(false);
  });

  it('the status request is correlation-only', () => {
    const schema = SCHEMAS['soul.archive.status.request.v1'];
    const properties = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toStrictEqual(['eventId']);
  });
});
