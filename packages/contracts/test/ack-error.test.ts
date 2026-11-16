import { describe, expect, it } from 'vitest';

import { ERROR_MESSAGE_MAX_LENGTH } from '../src/schemas/error.js';
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

describe('ErrorResponse carries an ErrorCode, never a StatusReason', () => {
  it('accepts a minimal error', () => {
    expect(isValid(ERROR, { error: { code: 'schema_invalid', message: 'invalid envelope' } })).toBe(
      true,
    );
  });

  it('accepts an allocated eventId', () => {
    const doc = { error: { code: 'archive_conflict', message: 'conflict', eventId: EVENT_ID } };
    expect(isValid(ERROR, doc)).toBe(true);
  });

  it('rejects a terminal status reason used as an error code', () => {
    for (const code of ['buffer_lost', 'ttl_expired', 'queue_overflow']) {
      const doc = { error: { code, message: 'x' } };
      expect(isValid(ERROR, doc)).toBe(false);
    }
  });

  it('requires a bounded, non-empty message', () => {
    expect(isValid(ERROR, { error: { code: 'internal_error', message: '' } })).toBe(false);
    expect(
      isValid(ERROR, {
        error: { code: 'internal_error', message: 'a'.repeat(ERROR_MESSAGE_MAX_LENGTH + 1) },
      }),
    ).toBe(false);
    expect(
      isValid(ERROR, {
        error: { code: 'internal_error', message: 'a'.repeat(ERROR_MESSAGE_MAX_LENGTH) },
      }),
    ).toBe(true);
  });

  it('rejects extra fields in either layer', () => {
    expect(isValid(ERROR, { error: { code: 'internal_error', message: 'x' }, trace: '...' })).toBe(
      false,
    );
    expect(
      isValid(ERROR, { error: { code: 'internal_error', message: 'x', statusReason: 'ttl_expired' } }),
    ).toBe(false);
  });

  it('rejects an eventId with the wrong prefix', () => {
    expect(
      isValid(ERROR, { error: { code: 'auth_failed', message: 'x', eventId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' } }),
    ).toBe(false);
  });
});
