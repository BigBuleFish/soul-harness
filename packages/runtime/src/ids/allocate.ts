/**
 * Harness identifier allocator.
 *
 * This is the first code that assigns persona / session / thread / run /
 * event / action identifiers, plus the auxiliary `tsk` and `cnf` forms that
 * share the same frozen algorithm (IDENTITY-PROTOCOL §3.1–§3.3).
 *
 * What it refuses to be:
 *   - no caller-supplied identifier (external parties may ask for a create,
 *     they may not choose the id)
 *   - no autoincrement
 *   - no third-party id library; entropy comes from `node:crypto` unless the
 *     caller injects a source for tests
 *   - no database access. A unique index is the deployment's last line of
 *     defence; this function only retries when `isOccupied` says so, and it
 *     never writes
 *   - no environment reads and no human-readable timestamps
 *
 * Allocating a `thr_` / `act_` / `cnf_` string does not create a thought, an
 * action, or an archive conflict record. Those tables and state machines are
 * later batches.
 */

import { randomBytes as cryptoRandomBytes } from 'node:crypto';

import {
  parseActionId,
  parseConflictRecordId,
  parseEventId,
  parsePersonaId,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseThreadId,
} from '@soul-harness/contracts';
import type {
  ActionId,
  ConflictRecordId,
  EventId,
  HarnessId,
  PersonaId,
  RunId,
  SessionId,
  TaskId,
  ThreadId,
} from '@soul-harness/contracts';

import { RuntimeError } from '../errors.js';
import { ID_ENTROPY_BYTES, encodeEntropy, encodeTimestamp } from './encode.js';

/**
 * How many fresh identifiers to try before giving up.
 *
 * IDENTITY-PROTOCOL §3.3 requires a retry and then an error. It does not
 * freeze the budget. Eight is the SH-008A choice: enough to ride out a
 * pathological predicate, small enough that a stuck predicate cannot spin.
 */
export const ID_ALLOCATION_MAX_ATTEMPTS = 8;

/** Inclusive ceiling for an explicit `maxAttempts`. The default stays 8. */
const ID_ALLOCATION_ATTEMPT_LIMIT = 128;

/** 48-bit millisecond space. 2^48 itself does not fit. */
const TIMESTAMP_LIMIT = 2 ** 48;

export const ALLOCATABLE_PREFIXES = [
  'psn',
  'ses',
  'thr',
  'run',
  'evt',
  'act',
  'tsk',
  'cnf',
] as const;

export type AllocatablePrefix = (typeof ALLOCATABLE_PREFIXES)[number];

const PREFIX_SET: ReadonlySet<string> = new Set(ALLOCATABLE_PREFIXES);

export interface AllocateOptions {
  /** Unix epoch milliseconds. Default: `Date.now`. */
  readonly now?: () => number;
  /**
   * Entropy source. Called with `ID_ENTROPY_BYTES` (10) and must return a
   * `Uint8Array` of that byte length. Default: `crypto.randomBytes`.
   */
  readonly randomBytes?: (size: number) => Uint8Array;
  /**
   * Return true when `candidate` is already taken. The allocator draws a new
   * identifier and tries again. Throw to abort; a throw is not a collision.
   * Omit the callback when the caller has no occupancy oracle yet — the
   * function then returns the first identifier and does not loop.
   */
  readonly isOccupied?: (candidate: string) => boolean;
  /**
   * Retry budget, integers `1..128`. Default {@link ID_ALLOCATION_MAX_ATTEMPTS}.
   * Ignored when `isOccupied` is omitted, because there is nothing to retry.
   */
  readonly maxAttempts?: number;
}

export { ID_ENTROPY_BYTES };

function assertOptions(options: AllocateOptions | undefined): AllocateOptions {
  if (options === undefined) {
    return {};
  }
  if (typeof options !== 'object' || options === null) {
    throw new RuntimeError('invalid_argument', 'allocate options must be an object');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new RuntimeError('invalid_argument', 'now must be a function');
  }
  if (options.randomBytes !== undefined && typeof options.randomBytes !== 'function') {
    throw new RuntimeError('invalid_argument', 'randomBytes must be a function');
  }
  if (options.isOccupied !== undefined && typeof options.isOccupied !== 'function') {
    throw new RuntimeError('invalid_argument', 'isOccupied must be a function');
  }
  return options;
}

function resolveMaxAttempts(options: AllocateOptions): number {
  const requested = options.maxAttempts;
  if (requested === undefined) {
    return ID_ALLOCATION_MAX_ATTEMPTS;
  }
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > ID_ALLOCATION_ATTEMPT_LIMIT
  ) {
    throw new RuntimeError('invalid_argument', 'maxAttempts must be an integer from 1 to 128');
  }
  return requested;
}

function readTimestamp(now: () => number): number {
  const value = now();
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= TIMESTAMP_LIMIT
  ) {
    throw new RuntimeError(
      'invalid_clock',
      'clock must return a Unix millisecond integer below 2^48',
    );
  }
  return value;
}

function readEntropy(randomBytes: (size: number) => Uint8Array): Uint8Array {
  const produced = randomBytes(ID_ENTROPY_BYTES);
  if (!(produced instanceof Uint8Array) || produced.byteLength !== ID_ENTROPY_BYTES) {
    throw new RuntimeError('invalid_entropy', 'entropy source must return 10 bytes');
  }
  // Copy before encoding so a reused buffer cannot change the section mid-way.
  return produced.slice();
}

function defaultRandomBytes(size: number): Uint8Array {
  return cryptoRandomBytes(size);
}

function parseAllocated(prefix: AllocatablePrefix, wire: string): HarnessId {
  const parsed = parseForPrefix(prefix, wire);
  if (parsed === null) {
    throw new RuntimeError('id_encoding', 'allocator produced an identifier contracts rejected', {
      details: { prefix },
    });
  }
  return parsed;
}

function parseForPrefix(prefix: AllocatablePrefix, wire: string): HarnessId | null {
  switch (prefix) {
    case 'psn':
      return parsePersonaId(wire);
    case 'ses':
      return parseSessionId(wire);
    case 'thr':
      return parseThreadId(wire);
    case 'run':
      return parseRunId(wire);
    case 'evt':
      return parseEventId(wire);
    case 'act':
      return parseActionId(wire);
    case 'tsk':
      return parseTaskId(wire);
    case 'cnf':
      return parseConflictRecordId(wire);
    default: {
      const unexpected: never = prefix;
      throw new RuntimeError('invalid_argument', 'prefix is not an allocatable identifier prefix', {
        details: { prefix: unexpected },
      });
    }
  }
}

function compose(prefix: AllocatablePrefix, ms: number, entropy: Uint8Array): string {
  return `${prefix}_${encodeTimestamp(ms)}${encodeEntropy(entropy)}`;
}

export function allocateId(prefix: 'psn', options?: AllocateOptions): PersonaId;
export function allocateId(prefix: 'ses', options?: AllocateOptions): SessionId;
export function allocateId(prefix: 'thr', options?: AllocateOptions): ThreadId;
export function allocateId(prefix: 'run', options?: AllocateOptions): RunId;
export function allocateId(prefix: 'evt', options?: AllocateOptions): EventId;
export function allocateId(prefix: 'act', options?: AllocateOptions): ActionId;
export function allocateId(prefix: 'tsk', options?: AllocateOptions): TaskId;
export function allocateId(prefix: 'cnf', options?: AllocateOptions): ConflictRecordId;
export function allocateId(prefix: AllocatablePrefix, options?: AllocateOptions): HarnessId;
export function allocateId(prefix: AllocatablePrefix, options?: AllocateOptions): HarnessId {
  if (!PREFIX_SET.has(prefix)) {
    throw new RuntimeError('invalid_argument', 'prefix is not an allocatable identifier prefix');
  }

  const settings = assertOptions(options);
  const now = settings.now ?? Date.now;
  const randomBytes = settings.randomBytes ?? defaultRandomBytes;
  const isOccupied = settings.isOccupied;
  const maxAttempts = resolveMaxAttempts(settings);

  // No oracle: one draw. Retrying would only burn entropy.
  const attempts = isOccupied === undefined ? 1 : maxAttempts;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const wire = compose(prefix, readTimestamp(now), readEntropy(randomBytes));
    const id = parseAllocated(prefix, wire);
    if (isOccupied === undefined) {
      return id;
    }
    const occupied = isOccupied(id);
    if (typeof occupied !== 'boolean') {
      throw new RuntimeError('invalid_argument', 'isOccupied must return a boolean', {
        details: { prefix },
      });
    }
    if (!occupied) {
      return id;
    }
  }

  throw new RuntimeError('id_collision', 'identifier allocation exhausted its retry budget', {
    details: { prefix, attempts },
  });
}

export function allocatePersonaId(options?: AllocateOptions): PersonaId {
  return allocateId('psn', options);
}

export function allocateSessionId(options?: AllocateOptions): SessionId {
  return allocateId('ses', options);
}

export function allocateThreadId(options?: AllocateOptions): ThreadId {
  return allocateId('thr', options);
}

export function allocateRunId(options?: AllocateOptions): RunId {
  return allocateId('run', options);
}

export function allocateEventId(options?: AllocateOptions): EventId {
  return allocateId('evt', options);
}

export function allocateActionId(options?: AllocateOptions): ActionId {
  return allocateId('act', options);
}

export function allocateTaskId(options?: AllocateOptions): TaskId {
  return allocateId('tsk', options);
}

export function allocateConflictRecordId(options?: AllocateOptions): ConflictRecordId {
  return allocateId('cnf', options);
}
