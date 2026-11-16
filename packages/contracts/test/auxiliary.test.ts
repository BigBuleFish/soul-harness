import { describe, expect, it } from 'vitest';

import { AUXILIARY_ID_PATTERN, CORE_ID_PATTERN } from '../src/ids/patterns.js';
import {
  isAuxiliaryId,
  isConflictRecordId,
  isCoreId,
  isTaskId,
  parseTaskId,
  parseConflictRecordId,
} from '../src/ids/validate.js';

const TASK = 'tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF';
const CONFLICT = 'cnf_01JQ8Z6B7P9R1T3V5X7Z9A2BDF';
const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';

const CORE_RE = new RegExp(CORE_ID_PATTERN, 'u');
const AUX_RE = new RegExp(AUXILIARY_ID_PATTERN, 'u');

describe('auxiliary identifiers are separate from the six core classes', () => {
  it('accepts task and conflict-record ids', () => {
    expect(isTaskId(TASK)).toBe(true);
    expect(isConflictRecordId(CONFLICT)).toBe(true);
    expect(isAuxiliaryId(TASK)).toBe(true);
    expect(isAuxiliaryId(CONFLICT)).toBe(true);
    expect(parseTaskId(TASK)).toBe(TASK);
    expect(parseConflictRecordId(CONFLICT)).toBe(CONFLICT);
  });

  it('are rejected by the core validator', () => {
    expect(isCoreId(TASK)).toBe(false);
    expect(isCoreId(CONFLICT)).toBe(false);
    expect(CORE_RE.test(TASK)).toBe(false);
    expect(CORE_RE.test(CONFLICT)).toBe(false);
  });

  it('do not accept core ids', () => {
    expect(isAuxiliaryId(PERSONA)).toBe(false);
    expect(isTaskId(PERSONA)).toBe(false);
    expect(isConflictRecordId('evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH')).toBe(false);
    expect(AUX_RE.test(PERSONA)).toBe(false);
  });

  it('do not cross-accept each other', () => {
    expect(isTaskId(CONFLICT)).toBe(false);
    expect(isConflictRecordId(TASK)).toBe(false);
  });

  it('keep the same length and alphabet as core ids', () => {
    expect(TASK).toHaveLength(30);
    expect(CONFLICT).toHaveLength(30);
    expect(isAuxiliaryId(`${TASK.slice(0, -1)}I`)).toBe(false);
    expect(isAuxiliaryId(TASK.slice(0, -1))).toBe(false);
  });

  it('rejects unknown auxiliary prefixes', () => {
    expect(isAuxiliaryId('xyz_01JQ8Z6B7P9R1T3V5X7Z9A2BDF')).toBe(false);
    expect(isAuxiliaryId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF'.toLowerCase())).toBe(false);
  });
});
