import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_MESSAGES, isCanonicalErrorMessage } from '../src/errors/codes.js';
import { errorsFor, isValid } from './helpers/validator.js';

const ACK = 'soul.ack.v1' as const;
const ERROR = 'soul.error.v1' as const;

const EVENT_ID = 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH';

describe('ACK is identity + status only (decision B3)', () => {
  it('accepts the minimal success shape', () => {
    expect(isValid(ACK, { eventId: EVENT_ID, status: 'accepted' })).toBe(true);
  });

  it('accepts a terminal status on an idempotent re-delivery', () => {
    expect(isValid(ACK, { eventId: EVENT_ID, status: 'expired' })).toBe(true);
    expect(isValid(ACK, { eventId: EVENT_ID, status: 'rejected' })).toBe(true);
  });

  it('rejects statusReason on an ACK', () => {
    const doc = { eventId: EVENT_ID, status: 'accepted', statusReason: 'buffer_lost' };
    expect(isValid(ACK, doc)).toBe(false);
    expect(errorsFor(ACK, doc)).toContain('additionalProperties');
  });

  it('rejects any other extra field', () => {
    for (const extra of [{ archiveRef: 'x' }, { archiveState: 'none' }, { requestNonce: 'x' }]) {
      expect(isValid(ACK, { eventId: EVENT_ID, status: 'accepted', ...extra })).toBe(false);
    }
  });

  it('requires both fields', () => {
    expect(isValid(ACK, { eventId: EVENT_ID })).toBe(false);
    expect(isValid(ACK, { status: 'accepted' })).toBe(false);
  });

  it('rejects a non-event id and an unknown status', () => {
    expect(isValid(ACK, { eventId: 'act_01JQ8Z8E0S2T4W6Y8A0B2C4EGJ', status: 'accepted' })).toBe(
      false,
    );
    expect(isValid(ACK, { eventId: EVENT_ID, status: 'queued' })).toBe(false);
  });
});

describe('error messages come from a fixed catalog', () => {
  it('has one canonical message per code', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toStrictEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      expect(ERROR_MESSAGES[code]).toMatch(/^[a-z0-9][a-z0-9 ,.'-]*$/);
    }
  });

  it('every canonical pair validates', () => {
    for (const code of ERROR_CODES) {
      const doc = { error: { code, message: ERROR_MESSAGES[code] } };
      expect(isValid(ERROR, doc), code).toBe(true);
      expect(isCanonicalErrorMessage(code, ERROR_MESSAGES[code])).toBe(true);
    }
  });

  it('rejects a caller-supplied message for a valid code', () => {
    const doc = { error: { code: 'schema_invalid', message: 'field requestNonce is too short: abc' } };
    expect(isValid(ERROR, doc)).toBe(false);
  });

  it('rejects an exception string or stack fragment', () => {
    for (const message of [
      'TypeError: Cannot read properties of undefined',
      '    at Ingress.parse (ingress.ts:42:11)',
      'ENOENT: no such file or directory, open C:\\soul\\data\\x.db',
    ]) {
      expect(isValid(ERROR, { error: { code: 'processing_failed', message } })).toBe(false);
    }
  });

  it('rejects echoed stimulus content', () => {
    for (const message of ['hello world', '用户: 你好', 'qq.message{"text":"secret"}']) {
      expect(isValid(ERROR, { error: { code: 'internal_error', message } })).toBe(false);
    }
  });

  it('rejects a message paired with the wrong code', () => {
    const doc = { error: { code: 'rate_limited', message: ERROR_MESSAGES.auth_failed } };
    expect(isValid(ERROR, doc)).toBe(false);
    expect(errorsFor(ERROR, doc).some((entry) => entry.startsWith('const'))).toBe(true);
  });

  it('accepts an allocated eventId but nothing else', () => {
    expect(
      isValid(ERROR, {
        error: {
          code: 'archive_conflict',
          message: ERROR_MESSAGES.archive_conflict,
          eventId: EVENT_ID,
        },
      }),
    ).toBe(true);
    expect(
      isValid(ERROR, {
        error: {
          code: 'archive_conflict',
          message: ERROR_MESSAGES.archive_conflict,
          trace: 'stack',
        },
      }),
    ).toBe(false);
  });

  it('rejects a terminal status reason used as an error code', () => {
    for (const code of ['buffer_lost', 'ttl_expired', 'queue_overflow']) {
      expect(isValid(ERROR, { error: { code, message: 'x' } })).toBe(false);
    }
  });

  it('rejects an eventId with the wrong prefix', () => {
    expect(
      isValid(ERROR, {
        error: {
          code: 'auth_failed',
          message: ERROR_MESSAGES.auth_failed,
          eventId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
        },
      }),
    ).toBe(false);
  });
});
