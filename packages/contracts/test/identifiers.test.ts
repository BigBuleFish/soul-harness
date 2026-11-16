import { describe, expect, it } from 'vitest';

import {
  ADAPTER_EVENT_REF_PATTERN,
  ADAPTER_ID_PATTERN,
  ARCHIVE_REF_PATTERN,
  BOOT_ID_PATTERN,
  PAYLOAD_KIND_PATTERN,
  REQUEST_NONCE_PATTERN,
  SOURCE_PATTERN,
} from '../src/ids/patterns.js';
import {
  isAdapterEventRef,
  isAdapterId,
  isArchiveRef,
  isBootId,
  isPayloadKind,
  isRequestNonce,
  isSourceId,
} from '../src/ids/validate.js';

const repeat = (char: string, times: number): string => char.repeat(times);

describe('requestNonce', () => {
  it('accepts the documented length window', () => {
    expect(isRequestNonce(repeat('a', 16))).toBe(true);
    expect(isRequestNonce(repeat('a', 64))).toBe(true);
    expect(isRequestNonce('NQ7xK2mR9tVb4Wc8')).toBe(true);
    expect(isRequestNonce('SAME-nonce-reused')).toBe(true);
  });

  it('rejects boundaries outside 16..64', () => {
    expect(isRequestNonce(repeat('a', 15))).toBe(false);
    expect(isRequestNonce(repeat('a', 65))).toBe(false);
    expect(isRequestNonce('')).toBe(false);
  });

  it('rejects characters outside the base64url alphabet', () => {
    expect(isRequestNonce('NQ7xK2mR9tVb4Wc.')).toBe(false); // dot
    expect(isRequestNonce('NQ7xK2mR9tVb4Wc=')).toBe(false); // padding
    expect(isRequestNonce('NQ7xK2mR9tVb4Wc ')).toBe(false); // space
    expect(isRequestNonce('NQ7xK2mR9tVb4Wc!')).toBe(false);
  });

  it('stays anchored (no partial match inside a longer string)', () => {
    expect(new RegExp(REQUEST_NONCE_PATTERN, 'u').test(`${repeat('a', 16)}!`)).toBe(false);
    expect(new RegExp(REQUEST_NONCE_PATTERN, 'u').test(`!${repeat('a', 16)}`)).toBe(false);
  });
});

describe('adapterEventRef', () => {
  it('accepts opaque references with the allowed separators', () => {
    expect(isAdapterEventRef('mc-7f3a9c21')).toBe(true);
    expect(isAdapterEventRef('a')).toBe(true);
    expect(isAdapterEventRef(repeat('a', 64))).toBe(true);
    expect(isAdapterEventRef('mc:7f3a.9c-21_0')).toBe(true);
  });

  it('rejects boundaries outside 1..64', () => {
    expect(isAdapterEventRef('')).toBe(false);
    expect(isAdapterEventRef(repeat('a', 65))).toBe(false);
  });

  it('rejects prose, paths, URLs and spaces', () => {
    expect(isAdapterEventRef('hello world')).toBe(false);
    expect(isAdapterEventRef('/tmp/message.json')).toBe(false);
    expect(isAdapterEventRef('https://example.com/x')).toBe(false);
    expect(isAdapterEventRef('用户消息')).toBe(false);
    expect(isAdapterEventRef('msg#1')).toBe(false);
  });

  it('is anchored', () => {
    expect(new RegExp(ADAPTER_EVENT_REF_PATTERN, 'u').test('mc-1 ')).toBe(false);
  });
});

describe('adapterId and source', () => {
  it('accept the controlled lower-case alphabet', () => {
    expect(isAdapterId('minecraft')).toBe(true);
    expect(isAdapterId('system.sleep')).toBe(true);
    expect(isAdapterId('qq')).toBe(true);
    expect(isAdapterId('a')).toBe(true);
    expect(isAdapterId(repeat('a', 64))).toBe(true);
    expect(isSourceId('minecraft.chat')).toBe(true);
    expect(isSourceId('qq.group')).toBe(true);
  });

  it('reject upper-case, spaces and empty values', () => {
    expect(isAdapterId('Minecraft')).toBe(false);
    expect(isAdapterId('mine craft')).toBe(false);
    expect(isAdapterId('')).toBe(false);
    expect(isAdapterId(repeat('a', 65))).toBe(false);
    expect(isSourceId('DSH.Chat')).toBe(false);
    expect(isSourceId('minecraft/chat')).toBe(false);
  });

  it('reject free text and paths', () => {
    expect(isAdapterId('用户')).toBe(false);
    expect(isSourceId('C:\\soul\\data')).toBe(false);
    expect(new RegExp(ADAPTER_ID_PATTERN, 'u').test('qq!')).toBe(false);
    expect(new RegExp(SOURCE_PATTERN, 'u').test('qq group')).toBe(false);
  });
});

describe('archiveRef', () => {
  it('accepts 1..128 opaque characters', () => {
    expect(isArchiveRef('a')).toBe(true);
    expect(isArchiveRef('evt_like-but-not-an-event-id')).toBe(true);
    expect(isArchiveRef(repeat('a', 128))).toBe(true);
  });

  it('rejects empty, oversized and path-like values', () => {
    expect(isArchiveRef('')).toBe(false);
    expect(isArchiveRef(repeat('a', 129))).toBe(false);
    expect(isArchiveRef('sealed-archive/2026/x.enc')).toBe(false);
    expect(isArchiveRef('C:\\sealed\\x')).toBe(false);
  });

  it('stays opaque: it is not forced to equal an eventId', () => {
    expect(new RegExp(ARCHIVE_REF_PATTERN, 'u').test('not-an-event-id')).toBe(true);
  });
});

describe('bootId', () => {
  it('accepts opaque instance tokens', () => {
    expect(isBootId('b')).toBe(true);
    expect(isBootId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isBootId(repeat('a', 64))).toBe(true);
  });

  it('rejects empty and oversized values', () => {
    expect(isBootId('')).toBe(false);
    expect(isBootId(repeat('a', 65))).toBe(false);
    expect(new RegExp(BOOT_ID_PATTERN, 'u').test('boot id')).toBe(false);
  });
});

describe('payload kind', () => {
  it('accepts namespaced lower-case type names', () => {
    expect(isPayloadKind('qq.message')).toBe(true);
    expect(isPayloadKind('mc.world')).toBe(true);
    expect(isPayloadKind('mc.player.state')).toBe(true);
    expect(isPayloadKind('a.b')).toBe(true);
  });

  it('rejects un-namespaced, upper-case or malformed names', () => {
    expect(isPayloadKind('message')).toBe(false);
    expect(isPayloadKind('QQ.message')).toBe(false);
    expect(isPayloadKind('qq.Message')).toBe(false);
    expect(isPayloadKind('qq..message')).toBe(false);
    expect(isPayloadKind('qq.')).toBe(false);
    expect(isPayloadKind('.qq')).toBe(false);
    expect(isPayloadKind('1qq.message')).toBe(false);
    expect(new RegExp(PAYLOAD_KIND_PATTERN, 'u').test('_qq.message')).toBe(false);
  });
});
