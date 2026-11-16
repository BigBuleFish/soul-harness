/**
 * Type-level assertions for the append response union.
 *
 * These are checked by `tsc` (the test glob is part of the typecheck project),
 * not at runtime: a `@ts-expect-error` that stops being an error fails the
 * build, so the discriminations cannot silently loosen.
 */

import { describe, expect, it } from 'vitest';

import type { ArchiveAppendResponse } from '../src/archive/ipc.js';
import type { ArchiveRef } from '../src/ids/types.js';

const REF = 'arc-7f3a9c21' as ArchiveRef;

// --- legal shapes -----------------------------------------------------------

const archived: ArchiveAppendResponse = { result: 'archived', archiveRef: REF };
const duplicate: ArchiveAppendResponse = { result: 'duplicate', archiveRef: REF };
const conflict: ArchiveAppendResponse = { result: 'conflict' };
const failed: ArchiveAppendResponse = { result: 'error', errorCode: 'archive_unavailable' };

// --- illegal shapes must not compile ---------------------------------------
// Each is written on one line so the directive covers the whole literal.

// @ts-expect-error archived requires an archiveRef
const archivedWithoutRef: ArchiveAppendResponse = { result: 'archived' };

// @ts-expect-error archived must not carry an errorCode
const archivedWithCode: ArchiveAppendResponse = { result: 'archived', archiveRef: REF, errorCode: 'internal_error' };

// @ts-expect-error duplicate requires an archiveRef
const duplicateWithoutRef: ArchiveAppendResponse = { result: 'duplicate' };

// @ts-expect-error conflict must not carry an archiveRef
const conflictWithRef: ArchiveAppendResponse = { result: 'conflict', archiveRef: REF };

// @ts-expect-error error requires an errorCode
const errorWithoutCode: ArchiveAppendResponse = { result: 'error' };

// @ts-expect-error error must not carry an archiveRef
const errorWithRef: ArchiveAppendResponse = { result: 'error', errorCode: 'internal_error', archiveRef: REF };

describe('append response union', () => {
  it('runtime values keep their discriminating field', () => {
    expect(archived.result).toBe('archived');
    expect(duplicate.result).toBe('duplicate');
    expect(conflict.result).toBe('conflict');
    expect(failed.result).toBe('error');
  });

  it('the illegal constructions above are type errors, not runtime values', () => {
    const illegal = [
      archivedWithoutRef,
      archivedWithCode,
      duplicateWithoutRef,
      conflictWithRef,
      errorWithoutCode,
      errorWithRef,
    ];
    // They exist only because TS objects; at runtime they are plain objects and
    // the schema is what rejects them. Asserting they are objects documents the
    // split of responsibilities: types stop the developer, schema stops the wire.
    for (const value of illegal) {
      expect(typeof value).toBe('object');
    }
  });
});
