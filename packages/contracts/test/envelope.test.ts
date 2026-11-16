import { describe, expect, it } from 'vitest';

import { SCHEMAS } from '../src/schemas/index.js';
import { errorsFor, isValid } from './helpers/validator.js';

const INPUT = 'soul.stimulus.input.v1' as const;
const NORMALIZED = 'soul.stimulus.v1' as const;

const propertiesOf = (id: typeof INPUT | typeof NORMALIZED): Record<string, unknown> =>
  SCHEMAS[id]['properties'] as Record<string, unknown>;

const baseInput = () => ({
  schema: 'soul.stimulus.input.v1',
  personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
  adapterId: 'minecraft',
  source: 'minecraft.chat',
  adapterEventRef: 'mc-7f3a9c21',
  requestNonce: 'NQ7xK2mR9tVb4Wc8',
  payload: { kind: 'mc.world', version: 1, world: 'overworld' },
});

const baseNormalized = () => ({
  ...baseInput(),
  schema: 'soul.stimulus.v1',
  receivedAt: 1_731_700_000_000,
});

describe('input envelope — adapters cannot supply receipt time', () => {
  it('accepts a minimal input envelope', () => {
    expect(isValid(INPUT, baseInput())).toBe(true);
  });

  it('accepts a source-claimed occurredAt', () => {
    expect(isValid(INPUT, { ...baseInput(), occurredAt: 1_731_699_999_000 })).toBe(true);
  });

  it('REJECTS an adapter-supplied receivedAt', () => {
    const doc = { ...baseInput(), receivedAt: 1_731_700_000_000 };
    expect(isValid(INPUT, doc)).toBe(false);
    expect(errorsFor(INPUT, doc)).toContain('additionalProperties');
  });

  it('does not declare receivedAt at all', () => {
    const properties = propertiesOf(INPUT);
    expect('receivedAt' in properties).toBe(false);
    expect('occurredAt' in properties).toBe(true);
  });

  it.each([
    'schema',
    'personaId',
    'adapterId',
    'source',
    'adapterEventRef',
    'requestNonce',
    'payload',
  ])('rejects a document missing %s', (field) => {
    const doc: Record<string, unknown> = baseInput();
    delete doc[field];
    expect(isValid(INPUT, doc)).toBe(false);
    expect(errorsFor(INPUT, doc)).toContain('required');
  });

  it('rejects an unknown top-level field', () => {
    const doc = { ...baseInput(), extraTopLevel: 'nope' };
    expect(isValid(INPUT, doc)).toBe(false);
    expect(errorsFor(INPUT, doc)).toContain('additionalProperties');
  });

  it('rejects a field that tries to declare audit scope', () => {
    expect(isValid(INPUT, { ...baseInput(), archiveDisposition: 'excluded' })).toBe(false);
  });
});

describe('normalized envelope — Ingress-owned receipt time', () => {
  it('accepts a normalized envelope', () => {
    expect(isValid(NORMALIZED, baseNormalized())).toBe(true);
  });

  it('requires receivedAt', () => {
    const doc: Record<string, unknown> = baseNormalized();
    delete doc['receivedAt'];
    expect(isValid(NORMALIZED, doc)).toBe(false);
    expect(errorsFor(NORMALIZED, doc)).toContain('required');
  });

  it('declares receivedAt and rejects the input version string', () => {
    expect('receivedAt' in propertiesOf(NORMALIZED)).toBe(true);
    expect(isValid(NORMALIZED, { ...baseNormalized(), schema: 'soul.stimulus.input.v1' })).toBe(
      false,
    );
  });

  it('rejects a negative or non-integer receivedAt', () => {
    expect(isValid(NORMALIZED, { ...baseNormalized(), receivedAt: -1 })).toBe(false);
    expect(isValid(NORMALIZED, { ...baseNormalized(), receivedAt: 1.5 })).toBe(false);
    expect(isValid(NORMALIZED, { ...baseNormalized(), receivedAt: '1731700000000' })).toBe(false);
  });

  it('keeps occurredAt optional and non-authoritative', () => {
    expect(isValid(NORMALIZED, baseNormalized())).toBe(true);
    expect(isValid(NORMALIZED, { ...baseNormalized(), occurredAt: 1_731_699_999_000 })).toBe(true);
  });

  it('rejects the same unknown top-level fields as the input envelope', () => {
    expect(isValid(NORMALIZED, { ...baseNormalized(), extraTopLevel: 'nope' })).toBe(false);
    expect(
      isValid(NORMALIZED, { ...baseNormalized(), eventId: 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH' }),
    ).toBe(false);
  });
});

describe('payload rules — identical at both layers', () => {
  it('allows unknown keys inside payload', () => {
    const payload = { kind: 'qq.message', version: 1, text: 'hi', nested: { a: [1, 2] } };
    expect(isValid(INPUT, { ...baseInput(), payload })).toBe(true);
    expect(isValid(NORMALIZED, { ...baseNormalized(), payload })).toBe(true);
  });

  it.each([['kind'], ['version']])('requires payload.%s', (field) => {
    const doc = baseInput();
    delete (doc.payload as Record<string, unknown>)[field];
    expect(isValid(INPUT, doc)).toBe(false);
  });

  it('rejects a non-object payload', () => {
    for (const payload of ['text', 42, [], null, true]) {
      expect(isValid(INPUT, { ...baseInput(), payload })).toBe(false);
    }
  });

  it('rejects a malformed or non-namespaced kind', () => {
    for (const kind of ['message', 'QQ.message', 'qq.Message', 'qq..message', '']) {
      expect(isValid(INPUT, { ...baseInput(), payload: { kind, version: 1 } })).toBe(false);
    }
  });

  it('rejects a non-positive or non-integer payload version', () => {
    for (const version of [0, -1, 1.5, '1']) {
      expect(isValid(INPUT, { ...baseInput(), payload: { kind: 'mc.world', version } })).toBe(false);
    }
  });
});

describe('field-level format enforcement', () => {
  it('rejects a personaId carrying a non-persona prefix', () => {
    const doc = { ...baseInput(), personaId: 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE' };
    expect(isValid(INPUT, doc)).toBe(false);
    expect(errorsFor(INPUT, doc)).toContain('pattern/personaId');
  });

  it('rejects a short requestNonce', () => {
    expect(isValid(INPUT, { ...baseInput(), requestNonce: 'too-short' })).toBe(false);
  });

  it('rejects an upper-case adapterId', () => {
    expect(isValid(INPUT, { ...baseInput(), adapterId: 'Minecraft' })).toBe(false);
  });

  it('rejects a wrong protocol version', () => {
    expect(isValid(INPUT, { ...baseInput(), schema: 'soul.stimulus.v2' })).toBe(false);
  });

  it('rejects an adapterEventRef containing a space', () => {
    expect(isValid(INPUT, { ...baseInput(), adapterEventRef: 'mc 7f3a9c21' })).toBe(false);
  });
});
