/**
 * OPEN-7 sample. The size below is the number recorded in
 * IDENTITY-PROTOCOL §11: 10_000 ids per allocatable prefix, plus a separate
 * 10_000-id burst drawn inside one injected millisecond.
 *
 * This is a CI acceptance check for format and in-sample uniqueness. It is
 * not a proof that a deployment can never collide; the protocol only requires
 * uniqueness inside one deployment, with a retry when the unique index says
 * the identifier is taken.
 */

import {
  ID_ALPHABET,
  ID_TOTAL_LENGTH,
  isActionId,
  isConflictRecordId,
  isCoreId,
  isEventId,
  isPersonaId,
  isRunId,
  isSessionId,
  isTaskId,
  isThreadId,
  parseActionId,
  parseConflictRecordId,
  parseEventId,
  parsePersonaId,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseThreadId,
} from '@soul-harness/contracts';
import type { HarnessId } from '@soul-harness/contracts';
import { describe, expect, it } from 'vitest';

import { ALLOCATABLE_PREFIXES, allocateId, allocatePersonaId } from '../src/index.js';
import type { AllocatablePrefix } from '../src/index.js';

/** Per-prefix sample, and the same-millisecond burst. Keep the two uses equal. */
export const ID_ALLOCATOR_SAMPLE_SIZE = 10_000;

const CLOCK = 1_763_592_000_000;

const PARSERS = {
  psn: { is: isPersonaId, parse: parsePersonaId, core: true },
  ses: { is: isSessionId, parse: parseSessionId, core: true },
  thr: { is: isThreadId, parse: parseThreadId, core: true },
  run: { is: isRunId, parse: parseRunId, core: true },
  evt: { is: isEventId, parse: parseEventId, core: true },
  act: { is: isActionId, parse: parseActionId, core: true },
  tsk: { is: isTaskId, parse: parseTaskId, core: false },
  cnf: { is: isConflictRecordId, parse: parseConflictRecordId, core: false },
} as const satisfies Record<
  AllocatablePrefix,
  {
    readonly is: (value: unknown) => boolean;
    readonly parse: (value: unknown) => HarnessId | null;
    readonly core: boolean;
  }
>;

function assertSample(prefix: AllocatablePrefix, ids: readonly string[]): void {
  const parser = PARSERS[prefix];
  const seen = new Set<string>();
  let timePrefix = '';
  for (const id of ids) {
    if (id.length !== ID_TOTAL_LENGTH) {
      throw new Error(`${prefix} length ${String(id.length)}`);
    }
    if (!id.startsWith(`${prefix}_`)) {
      throw new Error(`${prefix} bad prefix ${id.slice(0, 4)}`);
    }
    if (!parser.is(id) || parser.parse(id) !== id) {
      throw new Error(`${prefix} rejected by contracts`);
    }
    if (isCoreId(id) !== parser.core) {
      throw new Error(`${prefix} core/auxiliary mix-up`);
    }
    const body = id.slice(4);
    if (body.length !== 26) {
      throw new Error(`${prefix} body length`);
    }
    for (const char of body) {
      if (!ID_ALPHABET.includes(char) || 'ILOU'.includes(char)) {
        throw new Error(`${prefix} alphabet ${char}`);
      }
    }
    const stamp = id.slice(4, 14);
    if (!/^[0-7][0-9A-HJKMNP-TV-Z]{9}$/u.test(stamp)) {
      throw new Error(`${prefix} time prefix ${stamp}`);
    }
    if (timePrefix === '') {
      timePrefix = stamp;
    } else if (stamp !== timePrefix) {
      throw new Error(`${prefix} clock prefix drifted`);
    }
    if (seen.has(id)) {
      throw new Error(`${prefix} collided inside the sample`);
    }
    seen.add(id);
  }
  if (seen.size !== ids.length) {
    throw new Error(`${prefix} set size`);
  }
}

describe('OPEN-7 sample', () => {
  it(`draws ${String(ID_ALLOCATOR_SAMPLE_SIZE)} valid, unique ids for every prefix at one millisecond`, () => {
    for (const prefix of ALLOCATABLE_PREFIXES) {
      const ids: string[] = [];
      for (let i = 0; i < ID_ALLOCATOR_SAMPLE_SIZE; i += 1) {
        ids.push(allocateId(prefix, { now: () => CLOCK }));
      }
      assertSample(prefix, ids);
      const randomSections = new Set(ids.map((id) => id.slice(14)));
      expect(randomSections.size).toBe(ID_ALLOCATOR_SAMPLE_SIZE);
    }
  });

  it(`draws ${String(ID_ALLOCATOR_SAMPLE_SIZE)} persona ids in one millisecond without a repeated random section`, () => {
    const ids: string[] = [];
    for (let i = 0; i < ID_ALLOCATOR_SAMPLE_SIZE; i += 1) {
      ids.push(allocatePersonaId({ now: () => CLOCK }));
    }
    assertSample('psn', ids);
    expect(new Set(ids.map((id) => id.slice(14))).size).toBe(ID_ALLOCATOR_SAMPLE_SIZE);
  });
});
