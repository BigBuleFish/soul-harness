/**
 * Type-level assertions for the append response union.
 *
 * These are checked by `tsc` (the test glob is part of the typecheck project),
 * not at runtime: a `@ts-expect-error` that stops being an error fails the
 * build, so the discriminations cannot silently loosen.
 *
 * Every negative case is kept on one short line on purpose: a wrapped object
 * literal moves the excess-property error onto a different line than the
 * directive, and the assertion then silently stops guarding anything.
 */

import { describe, expect, it } from 'vitest';

import type { ArchiveAppendResponse } from '../src/archive/ipc.js';
import type { ArchiveRef } from '../src/ids/types.js';

type R = ArchiveAppendResponse;
const REF = 'arc-7f3a9c21' as ArchiveRef;
const CODE = 'internal_error';

// --- legal shapes -----------------------------------------------------------

const archived: R = { result: 'archived', archiveRef: REF };
const duplicate: R = { result: 'duplicate', archiveRef: REF };
const conflict: R = { result: 'conflict' };
const failed: R = { result: 'error', errorCode: CODE };

// --- illegal shapes must not compile ---------------------------------------

// @ts-expect-error archived requires an archiveRef
const noRef: R = { result: 'archived' };

// @ts-expect-error duplicate requires an archiveRef
const noRef2: R = { result: 'duplicate' };

// @ts-expect-error conflict must not carry an archiveRef
const conflictRef: R = { result: 'conflict', archiveRef: REF };

// @ts-expect-error error requires an errorCode
const noCode: R = { result: 'error' };

// @ts-expect-error error must not carry an archiveRef
const errorRef: R = { result: 'error', errorCode: CODE, archiveRef: REF };

// @ts-expect-error archived must not carry an errorCode
const archivedCode: R = { result: 'archived', archiveRef: REF, errorCode: CODE };

// @ts-expect-error duplicate must not carry an errorCode
const duplicateCode: R = { result: 'duplicate', archiveRef: REF, errorCode: CODE };

describe('append response union', () => {
  it('runtime values keep their discriminating field', () => {
    expect(archived.result).toBe('archived');
    expect(duplicate.result).toBe('duplicate');
    expect(conflict.result).toBe('conflict');
    expect(failed.result).toBe('error');
  });

  it('the illegal constructions above are type errors, not runtime values', () => {
    const illegal = [noRef, noRef2, conflictRef, noCode, errorRef, archivedCode, duplicateCode];
    // They exist only because TS objects; at runtime they are plain objects and
    // the schema is what rejects them. Asserting they are objects documents the
    // split of responsibilities: types stop the developer, schema stops the wire.
    for (const value of illegal) {
      expect(typeof value).toBe('object');
    }
  });
});
