import { describe, expect, it } from 'vitest';
import { expectTypeOf } from 'vitest';

import {
  ARCHIVE_DISPOSITIONS,
  ARCHIVE_STATES,
  ARCHIVE_WRITER_STATES,
  ATTENTION_OUTCOMES,
  CHANNELS,
  EVENT_STATUSES,
  RETENTION_CLASSES,
  isEventStatus,
} from '../src/events/enums.js';
import {
  EXPIRED_REASONS,
  NON_TERMINAL_EVENT_STATUSES,
  REJECTED_REASONS,
  STATUS_REASONS,
  isStatusReason,
} from '../src/events/status-reason.js';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  RETRYABLE_ERROR_CODES,
  isErrorCode,
} from '../src/errors/codes.js';
import type { ErrorCode } from '../src/errors/codes.js';
import type { StatusReason } from '../src/events/status-reason.js';

describe('enum completeness', () => {
  it('event status has exactly the eight documented values', () => {
    expect(EVENT_STATUSES).toStrictEqual([
      'received',
      'accepted',
      'noticed',
      'understood',
      'response_committed',
      'acted',
      'rejected',
      'expired',
    ]);
  });

  it('attention outcome has exactly the six documented values', () => {
    expect(ATTENTION_OUTCOMES).toStrictEqual([
      'not_evaluated',
      'ignored',
      'queued',
      'partially_aware',
      'fully_aware',
      'forced_control',
    ]);
  });

  it('archive state has exactly the five documented values', () => {
    expect(ARCHIVE_STATES).toStrictEqual(['none', 'pending', 'archived', 'failed', 'excluded']);
  });

  it('archive writer state is a separate, narrower enum', () => {
    expect(ARCHIVE_WRITER_STATES).toStrictEqual(['archived', 'failed', 'not_found']);
  });

  it('archive disposition, retention class and channels are fixed', () => {
    expect(ARCHIVE_DISPOSITIONS).toStrictEqual(['required', 'excluded']);
    expect(RETENTION_CLASSES).toStrictEqual(['standard', 'restricted', 'short_lived']);
    expect(CHANNELS).toStrictEqual(['external', 'inner', 'sleep', 'dream', 'audit']);
  });

  it('every enum is duplicate-free', () => {
    for (const list of [
      EVENT_STATUSES,
      ATTENTION_OUTCOMES,
      ARCHIVE_STATES,
      ARCHIVE_WRITER_STATES,
      ARCHIVE_DISPOSITIONS,
      RETENTION_CLASSES,
      CHANNELS,
      EXPIRED_REASONS,
      REJECTED_REASONS,
      ERROR_CODES,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('guards agree with the arrays', () => {
    expect(isEventStatus('accepted')).toBe(true);
    expect(isEventStatus('ACCEPTED')).toBe(false);
    expect(isStatusReason('buffer_lost')).toBe(true);
    expect(isStatusReason('compare_limited')).toBe(false);
    expect(isErrorCode('compare_limited')).toBe(true);
    expect(isErrorCode('buffer_lost')).toBe(false);
  });
});

describe('status reason pairing', () => {
  it('expired reasons are exactly three and rejected exactly seven', () => {
    expect(EXPIRED_REASONS).toStrictEqual(['buffer_lost', 'ttl_expired', 'queue_overflow']);
    expect(REJECTED_REASONS).toHaveLength(7);
  });

  it('the two reason groups are disjoint', () => {
    const overlap = EXPIRED_REASONS.filter((reason) =>
      (REJECTED_REASONS as readonly string[]).includes(reason),
    );
    expect(overlap).toStrictEqual([]);
  });

  it('the combined list is the union of both groups', () => {
    expect(STATUS_REASONS).toHaveLength(EXPIRED_REASONS.length + REJECTED_REASONS.length);
    for (const reason of [...EXPIRED_REASONS, ...REJECTED_REASONS]) {
      expect(STATUS_REASONS).toContain(reason);
    }
  });

  it('non-terminal statuses never carry a reason', () => {
    expect(NON_TERMINAL_EVENT_STATUSES).toStrictEqual([
      'received',
      'accepted',
      'noticed',
      'understood',
      'response_committed',
      'acted',
    ]);
    const terminal = ['expired', 'rejected'];
    for (const status of terminal) {
      expect(NON_TERMINAL_EVENT_STATUSES).not.toContain(status);
    }
    expect(NON_TERMINAL_EVENT_STATUSES.length + terminal.length).toBe(EVENT_STATUSES.length);
  });
});

describe('ErrorCode and StatusReason are different types', () => {
  it('is not the same TypeScript type', () => {
    expectTypeOf<ErrorCode>().not.toEqualTypeOf<StatusReason>();
    expectTypeOf<StatusReason>().not.toEqualTypeOf<ErrorCode>();
  });

  it('has members the other set must never contain', () => {
    expect(ERROR_CODES).toContain('compare_limited');
    expect(ERROR_CODES).toContain('internal_error');
    expect(STATUS_REASONS).not.toContain('compare_limited');
    expect(STATUS_REASONS).not.toContain('internal_error');

    expect(STATUS_REASONS).toContain('buffer_lost');
    expect(STATUS_REASONS).toContain('ttl_expired');
    expect(STATUS_REASONS).toContain('queue_overflow');
    expect(ERROR_CODES).not.toContain('buffer_lost');
    expect(ERROR_CODES).not.toContain('ttl_expired');
    expect(ERROR_CODES).not.toContain('queue_overflow');
  });

  it('shares only the rejection codes', () => {
    const overlap = ERROR_CODES.filter((code) =>
      (STATUS_REASONS as readonly string[]).includes(code),
    );
    expect([...overlap].sort()).toStrictEqual([...REJECTED_REASONS].sort());
  });

  it('maps every error code to a 4xx/5xx status', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_HTTP_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toStrictEqual([...ERROR_CODES].sort());
  });

  it('retryable codes are a subset of error codes', () => {
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
    expect(ERROR_HTTP_STATUS.rate_limited).toBe(429);
    expect(ERROR_HTTP_STATUS.compare_limited).toBe(429);
    expect(ERROR_HTTP_STATUS.archive_unavailable).toBe(503);
  });
});
