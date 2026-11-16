import { describe, expect, it } from 'vitest';

import { errorsFor, isValid } from './helpers/validator.js';

const SCHEMA = 'soul.stimulus.v1' as const;

const baseEnvelope = () => ({
  schema: 'soul.stimulus.v1',
  personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
  adapterId: 'minecraft',
  source: 'minecraft.chat',
  adapterEventRef: 'mc-7f3a9c21',
  requestNonce: 'NQ7xK2mR9tVb4Wc8',
  receivedAt: 1_731_700_000_000,
  payload: { kind: 'mc.world', version: 1, world: 'overworld' },
});

describe('stimulus v1 — required fields', () => {
  it('accepts a complete envelope', () => {
    const doc = { ...baseEnvelope(), occurredAt: 1_731_699_999_000 };
    expect(isValid(SCHEMA, doc)).toBe(true);
  });

  it('accepts a minimal envelope without occurredAt', () => {
    const doc = baseEnvelope();
    expect('occurredAt' in doc).toBe(false);
    expect(isValid(SCHEMA, doc)).toBe(true);
  });

  it.each([
    'schema',
    'personaId',
    'adapterId',
    'source',
    'adapterEventRef',
    'requestNonce',
    'receivedAt',
    'payload',
  ])('rejects a document missing %s', (field) => {
    const doc: Record<string, unknown> = baseEnvelope();
    delete doc[field];
    expect(isValid(SCHEMA, doc)).toBe(false);
    expect(errorsFor(SCHEMA, doc)).toContain('required');
  });
});

describe('stimulus v1 — closed top level (decision B2)', () => {
  it('rejects an unknown top-level field', () => {
    const doc = { ...baseEnvelope(), extraTopLevel: 'nope' };
    expect(isValid(SCHEMA, doc)).toBe(false);
    expect(errorsFor(SCHEMA, doc)).toContain('additionalProperties');
  });

  it('rejects a top-level field that tries to override identity', () => {
    const doc = { ...baseEnvelope(), eventId: 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });

  it('rejects a top-level attempt to declare audit scope', () => {
    const doc = { ...baseEnvelope(), archiveDisposition: 'excluded' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });
});

describe('stimulus v1 — payload is the open extension area', () => {
  it('allows unknown keys inside payload', () => {
    const doc = {
      ...baseEnvelope(),
      payload: { kind: 'qq.message', version: 1, text: 'hi', sender: 'u1', nested: { a: [1, 2] } },
    };
    expect(isValid(SCHEMA, doc)).toBe(true);
  });

  it.each([['kind'], ['version']])('requires payload.%s', (field) => {
    const doc = baseEnvelope();
    delete (doc.payload as Record<string, unknown>)[field];
    expect(isValid(SCHEMA, doc)).toBe(false);
  });

  it('rejects a non-object payload', () => {
    for (const payload of ['text', 42, [], null, true]) {
      const doc = { ...baseEnvelope(), payload };
      expect(isValid(SCHEMA, doc)).toBe(false);
    }
  });

  it('rejects a malformed or non-namespaced kind', () => {
    for (const kind of ['message', 'QQ.message', 'qq.Message', 'qq..message', '']) {
      const doc = { ...baseEnvelope(), payload: { kind, version: 1 } };
      expect(isValid(SCHEMA, doc)).toBe(false);
    }
  });

  it('rejects a non-positive or non-integer payload version', () => {
    for (const version of [0, -1, 1.5, '1']) {
      const doc = { ...baseEnvelope(), payload: { kind: 'mc.world', version } };
      expect(isValid(SCHEMA, doc)).toBe(false);
    }
  });
});

describe('stimulus v1 — field-level format enforcement', () => {
  it('rejects a personaId carrying a non-persona prefix', () => {
    const doc = { ...baseEnvelope(), personaId: 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE' };
    expect(isValid(SCHEMA, doc)).toBe(false);
    expect(errorsFor(SCHEMA, doc)).toContain('pattern/personaId');
  });

  it('rejects a short requestNonce', () => {
    const doc = { ...baseEnvelope(), requestNonce: 'too-short' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });

  it('rejects an upper-case adapterId', () => {
    const doc = { ...baseEnvelope(), adapterId: 'Minecraft' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });

  it('rejects a wrong protocol version', () => {
    const doc = { ...baseEnvelope(), schema: 'soul.stimulus.v2' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });

  it('rejects negative or string timestamps', () => {
    expect(isValid(SCHEMA, { ...baseEnvelope(), receivedAt: -1 })).toBe(false);
    expect(isValid(SCHEMA, { ...baseEnvelope(), receivedAt: '1731700000000' })).toBe(false);
    expect(isValid(SCHEMA, { ...baseEnvelope(), receivedAt: 1.5 })).toBe(false);
  });

  it('rejects an adapterEventRef containing a space', () => {
    const doc = { ...baseEnvelope(), adapterEventRef: 'mc 7f3a9c21' };
    expect(isValid(SCHEMA, doc)).toBe(false);
  });
});
