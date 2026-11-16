import { describe, expect, it } from 'vitest';

import {
  CORE_ID_PATTERN,
  ID_TOTAL_LENGTH,
  PERSONA_ID_PATTERN,
  SESSION_ID_PATTERN,
  THREAD_ID_PATTERN,
  RUN_ID_PATTERN,
  EVENT_ID_PATTERN,
  ACTION_ID_PATTERN,
} from '../src/ids/patterns.js';
import {
  isActionId,
  isCoreId,
  isEventId,
  isPersonaId,
  isRunId,
  isSessionId,
  isThreadId,
  parseEventId,
  parsePersonaId,
} from '../src/ids/validate.js';

/** One valid, documented-shaped example per core class. */
const VALID = {
  persona: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
  session: 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE',
  thread: 'thr_01JQ8Z5B7P9R1T3V5X7Z9A2BDF',
  run: 'run_01JQ8Z6C8Q0S2T4W6Y8A0B2CEG',
  event: 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH',
  action: 'act_01JQ8Z8E0S2T4W6Y8A0B2C4EGJ',
} as const;

const CORE_RE = new RegExp(CORE_ID_PATTERN, 'u');

describe('core identifiers — positive shapes', () => {
  it('accepts one documented example per class', () => {
    expect(isPersonaId(VALID.persona)).toBe(true);
    expect(isSessionId(VALID.session)).toBe(true);
    expect(isThreadId(VALID.thread)).toBe(true);
    expect(isRunId(VALID.run)).toBe(true);
    expect(isEventId(VALID.event)).toBe(true);
    expect(isActionId(VALID.action)).toBe(true);
  });

  it('has a fixed wire length of 30 characters', () => {
    for (const value of Object.values(VALID)) {
      expect(value).toHaveLength(ID_TOTAL_LENGTH);
      expect(CORE_RE.test(value)).toBe(true);
    }
  });

  it('is recognised by the shared core validator', () => {
    for (const value of Object.values(VALID)) {
      expect(isCoreId(value)).toBe(true);
    }
  });

  it('the core pattern contains exactly the six classes', () => {
    expect(CORE_ID_PATTERN).toBe('^(psn|ses|thr|run|evt|act)_[0-9A-HJKMNP-TV-Z]{26}$');
  });
});

describe('core identifiers — negative shapes', () => {
  it('rejects wrong length', () => {
    const base = VALID.event;
    expect(isEventId(base.slice(0, -1))).toBe(false); // 29
    expect(isEventId(`${base}A`)).toBe(false); // 31
    expect(isEventId('evt_')).toBe(false);
  });

  it('rejects lower-case bodies and prefixes', () => {
    expect(isEventId(VALID.event.toLowerCase())).toBe(false);
    expect(isPersonaId('PSN_01JQ8Z3K5M7P9R2T4V6X8Z0ABC')).toBe(false);
  });

  it('rejects the Crockford-excluded letters I, L, O, U', () => {
    const body = '01JQ8Z3K5M7P9R2T4V6X8Z0ABC';
    for (const letter of ['I', 'L', 'O', 'U']) {
      const candidate = `psn_${body.slice(0, 25)}${letter}`;
      expect(candidate).toHaveLength(ID_TOTAL_LENGTH);
      expect(isPersonaId(candidate)).toBe(false);
    }
  });

  it('rejects a cross-class prefix', () => {
    expect(isPersonaId(VALID.session)).toBe(false);
    expect(isSessionId(VALID.persona)).toBe(false);
    expect(new RegExp(SESSION_ID_PATTERN, 'u').test(VALID.persona)).toBe(false);
    expect(new RegExp(THREAD_ID_PATTERN, 'u').test(VALID.event)).toBe(false);
    expect(new RegExp(RUN_ID_PATTERN, 'u').test(VALID.action)).toBe(false);
    expect(new RegExp(EVENT_ID_PATTERN, 'u').test(VALID.thread)).toBe(false);
    expect(new RegExp(ACTION_ID_PATTERN, 'u').test(VALID.run)).toBe(false);
    expect(new RegExp(PERSONA_ID_PATTERN, 'u').test(VALID.session)).toBe(false);
  });

  it('rejects non-strings and empty input', () => {
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(isPersonaId(value)).toBe(false);
      expect(isCoreId(value)).toBe(false);
    }
    expect(isPersonaId('')).toBe(false);
  });

  it('rejects a body with an internal separator', () => {
    expect(isEventId('evt_01JQ8Z7D9R1T3V5X7Z9A1B3DF-')).toBe(false);
    expect(isEventId('evt_01JQ8Z7D9R1T3V5X7Z9A1B3D H')).toBe(false);
  });
});

describe('parsers narrow without generating', () => {
  it('returns the value or null', () => {
    expect(parsePersonaId(VALID.persona)).toBe(VALID.persona);
    expect(parsePersonaId('nope')).toBeNull();
    expect(parseEventId(VALID.event)).toBe(VALID.event);
    expect(parseEventId(VALID.persona)).toBeNull();
  });
});
