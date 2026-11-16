import { describe, expect, it } from 'vitest';

import { SCHEMAS } from '../src/schemas/index.js';
import { errorsFor, isValid } from './helpers/validator.js';

const APPEND_REQ = 'soul.archive.append.request.v1' as const;
const APPEND_RES = 'soul.archive.append.response.v1' as const;
const STATUS_REQ = 'soul.archive.status.request.v1' as const;
const STATUS_RES = 'soul.archive.status.response.v1' as const;
const COMPARE_REQ = 'soul.archive.compare.request.v1' as const;
const COMPARE_RES = 'soul.archive.compare.response.v1' as const;

const EVENT_ID = 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH';
const PERSONA_ID = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';
const REF = 'arc-7f3a9c21';

const appendRequest = () => ({
  eventId: EVENT_ID,
  personaId: PERSONA_ID,
  source: 'minecraft.chat',
  receivedAt: 1_731_700_000_000,
  retentionClass: 'standard',
  body: '{"kind":"mc.world","version":1,"tick":42}',
});

const compareRequest = () => ({
  eventId: EVENT_ID,
  personaId: PERSONA_ID,
  adapterId: 'minecraft',
  source: 'minecraft.chat',
  requestNonce: 'NQ7xK2mR9tVb4Wc8',
  candidateBody: '{"kind":"mc.world","version":1,"tick":42}',
});

describe('append — request may carry the original, response may not', () => {
  it('accepts a request with the body', () => {
    expect(isValid(APPEND_REQ, appendRequest())).toBe(true);
  });

  it('requires the body', () => {
    const doc: Record<string, unknown> = appendRequest();
    delete doc['body'];
    expect(isValid(APPEND_REQ, doc)).toBe(false);
    expect(errorsFor(APPEND_REQ, doc)).toContain('required');
  });

  it('rejects content-derived extras on the request', () => {
    for (const extra of [{ fingerprint: 'abc' }, { byteLength: 12 }, { contentEnc: 'x' }]) {
      expect(isValid(APPEND_REQ, { ...appendRequest(), ...extra })).toBe(false);
    }
  });

  it('accepts archived and duplicate responses with a ref', () => {
    expect(isValid(APPEND_RES, { result: 'archived', archiveRef: REF })).toBe(true);
    expect(isValid(APPEND_RES, { result: 'duplicate', archiveRef: REF })).toBe(true);
  });

  it('requires a ref when archived', () => {
    expect(isValid(APPEND_RES, { result: 'archived' })).toBe(false);
    expect(isValid(APPEND_RES, { result: 'duplicate' })).toBe(false);
  });

  it('forbids a ref on conflict and error', () => {
    expect(isValid(APPEND_RES, { result: 'conflict', archiveRef: REF })).toBe(false);
    expect(isValid(APPEND_RES, { result: 'error', archiveRef: REF })).toBe(false);
    expect(isValid(APPEND_RES, { result: 'conflict' })).toBe(true);
  });

  it('accepts an error result with a controlled error code', () => {
    expect(isValid(APPEND_RES, { result: 'error', errorCode: 'archive_unavailable' })).toBe(true);
    expect(isValid(APPEND_RES, { result: 'error', errorCode: 'buffer_lost' })).toBe(false);
  });

  it('never returns content on the response', () => {
    for (const extra of [{ body: 'x' }, { content: 'x' }, { fingerprint: 'x' }, { length: 1 }]) {
      expect(isValid(APPEND_RES, { result: 'archived', archiveRef: REF, ...extra })).toBe(false);
    }
  });
});

describe('status — three fields in, three fields out', () => {
  it('accepts a correlation-only request', () => {
    expect(isValid(STATUS_REQ, { eventId: EVENT_ID })).toBe(true);
  });

  it('rejects extra request fields, including persona scope', () => {
    expect(isValid(STATUS_REQ, { eventId: EVENT_ID, personaId: PERSONA_ID })).toBe(false);
    expect(isValid(STATUS_REQ, { eventId: EVENT_ID, body: 'x' })).toBe(false);
  });

  it('accepts archived with a ref', () => {
    const doc = { eventId: EVENT_ID, archiveState: 'archived', archiveRef: REF };
    expect(isValid(STATUS_RES, doc)).toBe(true);
  });

  it('pairs archiveRef with archiveState', () => {
    expect(isValid(STATUS_RES, { eventId: EVENT_ID, archiveState: 'archived', archiveRef: null })).toBe(
      false,
    );
    expect(isValid(STATUS_RES, { eventId: EVENT_ID, archiveState: 'failed', archiveRef: REF })).toBe(
      false,
    );
    expect(isValid(STATUS_RES, { eventId: EVENT_ID, archiveState: 'not_found', archiveRef: REF })).toBe(
      false,
    );
  });

  it('accepts a null ref for non-archived states', () => {
    expect(isValid(STATUS_RES, { eventId: EVENT_ID, archiveState: 'failed', archiveRef: null })).toBe(
      true,
    );
    expect(
      isValid(STATUS_RES, { eventId: EVENT_ID, archiveState: 'not_found', archiveRef: null }),
    ).toBe(true);
  });

  it('rejects events-side archive states the archive cannot observe', () => {
    for (const archiveState of ['none', 'pending', 'excluded']) {
      expect(isValid(STATUS_RES, { eventId: EVENT_ID, archiveState, archiveRef: null })).toBe(false);
    }
  });

  it('never returns content', () => {
    const doc = {
      eventId: EVENT_ID,
      archiveState: 'archived',
      archiveRef: REF,
      body: 'x',
    };
    expect(isValid(STATUS_RES, doc)).toBe(false);
  });
});

describe('compare — bounded request, three-valued response', () => {
  it('accepts a fully bound request with the candidate body', () => {
    expect(isValid(COMPARE_REQ, compareRequest())).toBe(true);
  });

  it.each(['eventId', 'personaId', 'adapterId', 'source', 'requestNonce', 'candidateBody'])(
    'requires %s',
    (field) => {
      const doc: Record<string, unknown> = compareRequest();
      delete doc[field];
      expect(isValid(COMPARE_REQ, doc)).toBe(false);
    },
  );

  it('rejects unbound or content-derived extras on the request', () => {
    for (const extra of [
      { adapterEventRef: 'mc-1' },
      { archiveRef: REF },
      { fingerprint: 'abc' },
      { body: 'x' },
    ]) {
      expect(isValid(COMPARE_REQ, { ...compareRequest(), ...extra })).toBe(false);
    }
  });

  it('returns exactly one of three verdicts', () => {
    for (const result of ['match', 'conflict', 'not_found']) {
      expect(isValid(COMPARE_RES, { result })).toBe(true);
    }
    for (const result of ['ok', 'archived', 'error', 'MATCH']) {
      expect(isValid(COMPARE_RES, { result })).toBe(false);
    }
  });

  it('refuses every extra field, including an eventId echo', () => {
    for (const extra of [
      { eventId: EVENT_ID },
      { content: 'x' },
      { candidateBody: 'x' },
      { fingerprint: 'x' },
      { length: 1 },
      { archiveRef: REF },
    ]) {
      expect(isValid(COMPARE_RES, { result: 'match', ...extra })).toBe(false);
      expect(errorsFor(COMPARE_RES, { result: 'match', ...extra })).toContain('additionalProperties');
    }
  });

  it('declares only `result` on the response', () => {
    const properties = SCHEMAS[COMPARE_RES]['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toStrictEqual(['result']);
  });
});

describe('the three archive interfaces stay separate', () => {
  it('has six distinct schemas, not one generic result type', () => {
    const ids = [APPEND_REQ, APPEND_RES, STATUS_REQ, STATUS_RES, COMPARE_REQ, COMPARE_RES];
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      expect(SCHEMAS[id]).toBeDefined();
    }
  });

  it('gives each response its own result vocabulary', () => {
    const appendProps = SCHEMAS[APPEND_RES]['properties'] as Record<string, Record<string, unknown>>;
    const statusProps = SCHEMAS[STATUS_RES]['properties'] as Record<string, Record<string, unknown>>;
    const compareProps = SCHEMAS[COMPARE_RES]['properties'] as Record<string, Record<string, unknown>>;

    expect(appendProps['result']?.['enum']).toStrictEqual([
      'archived',
      'duplicate',
      'conflict',
      'error',
    ]);
    expect(compareProps['result']?.['enum']).toStrictEqual(['match', 'conflict', 'not_found']);
    expect(statusProps['archiveState']?.['enum']).toStrictEqual(['archived', 'failed', 'not_found']);
  });
});
