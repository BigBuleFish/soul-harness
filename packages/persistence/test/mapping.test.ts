import { describe, expect, it } from 'vitest';

import type { PersistenceError } from '../src/errors.js';
import {
  JSON_COLUMN_SCHEMA_KEY,
  camelizeRow,
  decodeJsonColumn,
  encodeJsonColumn,
  fromDbBoolean,
  isMappedPair,
  toCamelCase,
  toDbBoolean,
  toSnakeCase,
} from '../src/index.js';
import { P1_TABLE_COLUMNS } from '../src/migrations/expected-schema.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

describe('name mapping is mechanical and reversible', () => {
  it('converts the documented examples', () => {
    expect(toSnakeCase('personaId')).toBe('persona_id');
    expect(toSnakeCase('receivedAt')).toBe('received_at');
    expect(toSnakeCase('adapterEventRef')).toBe('adapter_event_ref');
    expect(toSnakeCase('id')).toBe('id');

    expect(toCamelCase('persona_id')).toBe('personaId');
    expect(toCamelCase('received_at')).toBe('receivedAt');
    expect(toCamelCase('adapter_event_ref')).toBe('adapterEventRef');
    expect(toCamelCase('id')).toBe('id');
  });

  it('round-trips every column of the six P1 tables', () => {
    for (const [table, columns] of Object.entries(P1_TABLE_COLUMNS)) {
      for (const column of columns) {
        const camel = toCamelCase(column);
        expect(toSnakeCase(camel), `${table}.${column} → ${camel}`).toBe(column);
        expect(isMappedPair(camel, column), `${table}.${column}`).toBe(true);
      }
    }
  });

  it('rejects names that are not lower camelCase', () => {
    for (const name of [
      '',
      'PersonaId',
      '_personaId',
      'persona_id',
      'persona id',
      'persona-id',
      '1id',
    ]) {
      expect(
        codeOf(() => toSnakeCase(name)),
        name,
      ).toBe('invalid_field_name');
    }
  });

  it('rejects names that are not snake_case', () => {
    for (const name of [
      '',
      'personaId',
      '_persona',
      'persona_',
      'persona__id',
      'persona id',
      'Persona_id',
    ]) {
      expect(
        codeOf(() => toCamelCase(name)),
        name,
      ).toBe('invalid_field_name');
    }
  });
});

describe('row mapping', () => {
  it('converts keys and leaves values untouched', () => {
    const mapped = camelizeRow<Record<string, unknown>>({
      persona_id: 'psn_1',
      display_name: 'Primary',
      closed_at: null,
      opened_at: 1_731_700_000_000,
      meta_json: null,
    });

    expect(mapped).toStrictEqual({
      personaId: 'psn_1',
      displayName: 'Primary',
      closedAt: null,
      openedAt: 1_731_700_000_000,
      metaJson: null,
    });
  });

  it('keeps null exactly as null rather than undefined or empty string', () => {
    const mapped = camelizeRow<Record<string, unknown>>({ closed_at: null });
    expect(mapped['closedAt']).toBeNull();
    expect(mapped['closedAt']).not.toBeUndefined();
  });
});

describe('boolean columns', () => {
  it('maps booleans to 0/1 and back', () => {
    expect(toDbBoolean(true)).toBe(1);
    expect(toDbBoolean(false)).toBe(0);
    expect(fromDbBoolean('flag', 1)).toBe(true);
    expect(fromDbBoolean('flag', 0)).toBe(false);
  });

  it('refuses values that are not 0 or 1', () => {
    for (const value of [2, -1, '1', null, undefined, 0.5]) {
      expect(codeOf(() => fromDbBoolean('flag', value))).toBe('invalid_column_value');
    }
  });
});

describe('JSON columns carry a schema marker', () => {
  it('round-trips a payload with its shape version', () => {
    const text = encodeJsonColumn('soul.test.v1', { a: 1, nested: { b: [true, null] } });

    expect(JSON.parse(text)).toStrictEqual({
      schema: 'soul.test.v1',
      a: 1,
      nested: { b: [true, null] },
    });

    expect(decodeJsonColumn('column', 'soul.test.v1', text)).toStrictEqual({
      a: 1,
      nested: { b: [true, null] },
    });
  });

  it('refuses a payload that tries to set its own schema marker', () => {
    expect(
      codeOf(() => encodeJsonColumn('soul.test.v1', { [JSON_COLUMN_SCHEMA_KEY]: 'other' })),
    ).toBe('invalid_json_column');
  });

  it('refuses an empty schema id', () => {
    expect(codeOf(() => encodeJsonColumn('  ', { a: 1 }))).toBe('invalid_json_column');
  });

  it('refuses malformed or non-object JSON', () => {
    expect(codeOf(() => decodeJsonColumn('column', 'soul.test.v1', 'not json'))).toBe(
      'invalid_json_column',
    );
    expect(codeOf(() => decodeJsonColumn('column', 'soul.test.v1', '[1,2]'))).toBe(
      'invalid_json_column',
    );
    expect(codeOf(() => decodeJsonColumn('column', 'soul.test.v1', 'null'))).toBe(
      'invalid_json_column',
    );
  });

  it('refuses a payload written under a different schema id', () => {
    const text = encodeJsonColumn('soul.other.v1', { a: 1 });
    expect(codeOf(() => decodeJsonColumn('column', 'soul.test.v1', text))).toBe(
      'invalid_json_column',
    );
  });
});
