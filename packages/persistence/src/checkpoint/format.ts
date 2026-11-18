/**
 * Checkpoint envelope format.
 *
 * Architecture authority:
 *   - DATA-MODEL §3.1: `runtime_state.checkpoint_json` may hold cursors, queue
 *     positions, version numbers and active-id lists — never content, dialogue
 *     fragments or thought text.
 *   - RUNTIME-LIFECYCLE §3 step 5: a checkpoint must carry its `epoch`.
 *   - RUNTIME-LIFECYCLE §4 / DATA-MODEL §7: a checkpoint whose epoch is older
 *     than the current one must be discarded.
 *
 * What this module deliberately does NOT define: a persona/runtime state model.
 * The architecture fixes the *container* (a versioned envelope) and the allowed
 * *kinds* of payload (cursors and ID references), but not the business payload
 * itself, so the envelope carries only:
 *
 *   { "schema": "soul.runtime.checkpoint.v1", "version": 1, "epoch": 7,
 *     "refs": { "cursor": "...", "threadIds": [...], "runIds": [...] } }
 *
 * Everything is validated by hand (no schema library at runtime, no new
 * dependency) and unknown keys are rejected: silently ignoring them would let a
 * future writer smuggle content past this boundary.
 */

import { isRunId, isThreadId } from '@soul-harness/contracts';
import type { RunId, ThreadId } from '@soul-harness/contracts';

import { PersistenceError } from '../errors.js';

/** Wire identity of the envelope. Bumping it is a contract change. */
export const CHECKPOINT_SCHEMA = 'soul.runtime.checkpoint.v1';

/** The only envelope version this build can read or write. */
export const CHECKPOINT_VERSION = 1;

/** Upper bound on the stored JSON, so a checkpoint can never become a content store. */
export const CHECKPOINT_MAX_BYTES = 65_536;

/** Upper bound on each reference list. */
export const CHECKPOINT_MAX_REFS = 256;

/** Cursor tokens are opaque: no spaces, no prose, no paths. */
export const CHECKPOINT_CURSOR_PATTERN = '^[A-Za-z0-9._:-]{1,128}$';

const CURSOR = new RegExp(CHECKPOINT_CURSOR_PATTERN, 'u');

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(['schema', 'version', 'epoch', 'refs']);
const REFS_KEYS: ReadonlySet<string> = new Set(['cursor', 'threadIds', 'runIds']);

/** References-only payload: cursors and IDs, never content. */
export interface CheckpointRefs {
  /** Scheduler/queue cursor (opaque token). */
  readonly cursor?: string;
  /** Threads the runtime considers active at checkpoint time. */
  readonly threadIds?: readonly ThreadId[];
  /** Runs the runtime considers active at checkpoint time. */
  readonly runIds?: readonly RunId[];
}

export interface Checkpoint {
  readonly schema: typeof CHECKPOINT_SCHEMA;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly epoch: number;
  readonly refs?: CheckpointRefs;
}

function invalid(message: string, cause?: unknown): PersistenceError {
  return new PersistenceError(
    'checkpoint_invalid',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unsupported(message: string): PersistenceError {
  return new PersistenceError('checkpoint_version_unsupported', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function assertEpoch(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`checkpoint ${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Validates the caller-supplied payload before it reaches SQL.
 *
 * Runs before the write transaction opens, so a rejected value never reaches the
 * database.
 */
function normalizeRefs(refs: CheckpointRefs | undefined): CheckpointRefs | undefined {
  if (refs === undefined) {
    return undefined;
  }
  if (!isPlainObject(refs)) {
    throw invalid('checkpoint refs must be an object');
  }

  const record = refs as unknown as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!REFS_KEYS.has(key)) {
      throw invalid('checkpoint refs contain an unsupported field');
    }
  }

  const normalized: { cursor?: string; threadIds?: ThreadId[]; runIds?: RunId[] } = {};

  const cursor = record['cursor'];
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !CURSOR.test(cursor)) {
      throw invalid('checkpoint cursor must be an opaque token');
    }
    normalized.cursor = cursor;
  }

  const threadIds = record['threadIds'];
  if (threadIds !== undefined) {
    normalized.threadIds = collectIds(threadIds, isThreadId, 'threadIds');
  }

  const runIds = record['runIds'];
  if (runIds !== undefined) {
    normalized.runIds = collectIds(runIds, isRunId, 'runIds');
  }

  return normalized;
}

function collectIds<TId extends string>(
  values: unknown,
  isId: (value: unknown) => value is TId,
  field: string,
): TId[] {
  if (!Array.isArray(values)) {
    throw invalid(`checkpoint ${field} must be an array`);
  }
  if (values.length > CHECKPOINT_MAX_REFS) {
    throw invalid(`checkpoint ${field} exceeds the reference limit`);
  }
  return values.map((value) => {
    if (!isId(value)) {
      throw invalid(`checkpoint ${field} contains an invalid id`);
    }
    return value as TId;
  });
}

/** Serializes a checkpoint envelope; throws on invalid input. */
export function encodeCheckpoint(epoch: number, refs?: CheckpointRefs): string {
  const boundedEpoch = assertEpoch(epoch, 'epoch');
  const normalizedRefs = normalizeRefs(refs);

  const envelope: Checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    version: CHECKPOINT_VERSION,
    epoch: boundedEpoch,
    ...(normalizedRefs === undefined ? {} : { refs: normalizedRefs }),
  };

  const text = JSON.stringify(envelope);
  if (byteLength(text) > CHECKPOINT_MAX_BYTES) {
    throw invalid('checkpoint exceeds the maximum size');
  }
  return text;
}

/**
 * Parses and validates a stored checkpoint.
 *
 * Corruption and unknown versions are errors, never "empty": silently treating
 * them as absent would let a runtime start from a wrong state without noticing.
 */
export function decodeCheckpoint(text: string): Checkpoint {
  if (byteLength(text) > CHECKPOINT_MAX_BYTES) {
    throw invalid('stored checkpoint exceeds the maximum size');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid('stored checkpoint is not valid JSON', error);
  }

  if (!isPlainObject(parsed)) {
    throw invalid('stored checkpoint is not a JSON object');
  }

  for (const key of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw invalid('stored checkpoint contains an unsupported field');
    }
  }

  const schema = parsed['schema'];
  if (typeof schema !== 'string') {
    throw invalid('stored checkpoint is missing its schema field');
  }
  if (schema !== CHECKPOINT_SCHEMA) {
    throw unsupported('stored checkpoint has an unsupported schema');
  }

  const version = parsed['version'];
  if (typeof version !== 'number') {
    throw invalid('stored checkpoint is missing its version field');
  }
  if (version !== CHECKPOINT_VERSION) {
    throw unsupported('stored checkpoint has an unsupported version');
  }

  const epoch = assertEpoch(parsed['epoch'], 'epoch');

  let refs: CheckpointRefs | undefined;
  const rawRefs = parsed['refs'];
  if (rawRefs !== undefined) {
    if (!isPlainObject(rawRefs)) {
      throw invalid('stored checkpoint refs are not an object');
    }
    refs = normalizeRefs(rawRefs as CheckpointRefs);
  }

  return {
    schema: CHECKPOINT_SCHEMA,
    version: CHECKPOINT_VERSION,
    epoch,
    ...(refs === undefined ? {} : { refs }),
  };
}
