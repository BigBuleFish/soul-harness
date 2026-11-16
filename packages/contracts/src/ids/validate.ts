/**
 * Pure format validators for identifiers and controlled names.
 *
 * Every function here is total, side-effect free and allocation-light: it
 * answers "is this string in the canonical wire shape" and nothing else. No
 * function generates, mutates, normalises or repairs a value.
 */

import {
  ACTION_ID_PATTERN,
  ADAPTER_EVENT_REF_PATTERN,
  ADAPTER_ID_PATTERN,
  ARCHIVE_REF_PATTERN,
  AUXILIARY_ID_PATTERN,
  BOOT_ID_PATTERN,
  CONFLICT_RECORD_ID_PATTERN,
  CORE_ID_PATTERN,
  EVENT_ID_PATTERN,
  PAYLOAD_KIND_PATTERN,
  PERSONA_ID_PATTERN,
  REQUEST_NONCE_PATTERN,
  RUN_ID_PATTERN,
  SESSION_ID_PATTERN,
  SOURCE_PATTERN,
  TASK_ID_PATTERN,
  THREAD_ID_PATTERN,
} from './patterns.js';
import type {
  ActionId,
  AdapterEventRef,
  AdapterId,
  ArchiveRef,
  AuxiliaryId,
  BootId,
  ConflictRecordId,
  CoreId,
  EventId,
  PersonaId,
  RequestNonce,
  RunId,
  SessionId,
  SourceId,
  TaskId,
  ThreadId,
} from './types.js';

const coreIdRe = new RegExp(CORE_ID_PATTERN, 'u');
const auxiliaryIdRe = new RegExp(AUXILIARY_ID_PATTERN, 'u');

const personaIdRe = new RegExp(PERSONA_ID_PATTERN, 'u');
const sessionIdRe = new RegExp(SESSION_ID_PATTERN, 'u');
const threadIdRe = new RegExp(THREAD_ID_PATTERN, 'u');
const runIdRe = new RegExp(RUN_ID_PATTERN, 'u');
const eventIdRe = new RegExp(EVENT_ID_PATTERN, 'u');
const actionIdRe = new RegExp(ACTION_ID_PATTERN, 'u');
const taskIdRe = new RegExp(TASK_ID_PATTERN, 'u');
const conflictRecordIdRe = new RegExp(CONFLICT_RECORD_ID_PATTERN, 'u');

const adapterIdRe = new RegExp(ADAPTER_ID_PATTERN, 'u');
const sourceRe = new RegExp(SOURCE_PATTERN, 'u');
const adapterEventRefRe = new RegExp(ADAPTER_EVENT_REF_PATTERN, 'u');
const requestNonceRe = new RegExp(REQUEST_NONCE_PATTERN, 'u');
const archiveRefRe = new RegExp(ARCHIVE_REF_PATTERN, 'u');
const bootIdRe = new RegExp(BOOT_ID_PATTERN, 'u');
const payloadKindRe = new RegExp(PAYLOAD_KIND_PATTERN, 'u');

function matches(re: RegExp, value: unknown): boolean {
  return typeof value === 'string' && re.test(value);
}

export function isPersonaId(value: unknown): value is PersonaId {
  return matches(personaIdRe, value);
}
export function isSessionId(value: unknown): value is SessionId {
  return matches(sessionIdRe, value);
}
export function isThreadId(value: unknown): value is ThreadId {
  return matches(threadIdRe, value);
}
export function isRunId(value: unknown): value is RunId {
  return matches(runIdRe, value);
}
export function isEventId(value: unknown): value is EventId {
  return matches(eventIdRe, value);
}
export function isActionId(value: unknown): value is ActionId {
  return matches(actionIdRe, value);
}
export function isTaskId(value: unknown): value is TaskId {
  return matches(taskIdRe, value);
}
export function isConflictRecordId(value: unknown): value is ConflictRecordId {
  return matches(conflictRecordIdRe, value);
}

/**
 * True for the six core identity classes only.
 * Deliberately false for `tsk_` / `cnf_`: the core contract must not absorb
 * auxiliary prefixes, otherwise "six identities" stops constraining anything.
 */
export function isCoreId(value: unknown): value is CoreId {
  return matches(coreIdRe, value);
}

/** True for `tsk_` / `cnf_` only; disjoint from `isCoreId`. */
export function isAuxiliaryId(value: unknown): value is AuxiliaryId {
  return matches(auxiliaryIdRe, value);
}

export function isAdapterId(value: unknown): value is AdapterId {
  return matches(adapterIdRe, value);
}
export function isSourceId(value: unknown): value is SourceId {
  return matches(sourceRe, value);
}
export function isAdapterEventRef(value: unknown): value is AdapterEventRef {
  return matches(adapterEventRefRe, value);
}
export function isRequestNonce(value: unknown): value is RequestNonce {
  return matches(requestNonceRe, value);
}
export function isArchiveRef(value: unknown): value is ArchiveRef {
  return matches(archiveRefRe, value);
}
export function isBootId(value: unknown): value is BootId {
  return matches(bootIdRe, value);
}
export function isPayloadKind(value: unknown): boolean {
  return matches(payloadKindRe, value);
}

export function parsePersonaId(value: unknown): PersonaId | null {
  return isPersonaId(value) ? value : null;
}
export function parseSessionId(value: unknown): SessionId | null {
  return isSessionId(value) ? value : null;
}
export function parseThreadId(value: unknown): ThreadId | null {
  return isThreadId(value) ? value : null;
}
export function parseRunId(value: unknown): RunId | null {
  return isRunId(value) ? value : null;
}
export function parseEventId(value: unknown): EventId | null {
  return isEventId(value) ? value : null;
}
export function parseActionId(value: unknown): ActionId | null {
  return isActionId(value) ? value : null;
}
export function parseTaskId(value: unknown): TaskId | null {
  return isTaskId(value) ? value : null;
}
export function parseConflictRecordId(value: unknown): ConflictRecordId | null {
  return isConflictRecordId(value) ? value : null;
}
export function parseArchiveRef(value: unknown): ArchiveRef | null {
  return isArchiveRef(value) ? value : null;
}
export function parseBootId(value: unknown): BootId | null {
  return isBootId(value) ? value : null;
}
export function parseAdapterId(value: unknown): AdapterId | null {
  return isAdapterId(value) ? value : null;
}
export function parseSourceId(value: unknown): SourceId | null {
  return isSourceId(value) ? value : null;
}
export function parseAdapterEventRef(value: unknown): AdapterEventRef | null {
  return isAdapterEventRef(value) ? value : null;
}
export function parseRequestNonce(value: unknown): RequestNonce | null {
  return isRequestNonce(value) ? value : null;
}
