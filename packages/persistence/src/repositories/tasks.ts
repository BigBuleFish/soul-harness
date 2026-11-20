/**
 * tasks repository — conditional state machine over `tasks`.
 *
 * Every lifecycle transition has exactly one method and one guarded UPDATE:
 *
 *   insertQueuedTask → claimNext → completeTask / failTask
 *   running (post-crash) → recoverRunningTask
 *   queued|paused → failExhaustedTask / setTaskState
 *
 * There is no generic "set any state" write: `insert`/`updateState` were removed
 * so a caller cannot bypass the claim guard, the `run_id`/`attempt` CAS, or the
 * attempt cap. `payload_json` carries references only (DATA-MODEL §3.1); the
 * whitelist is enforced here, before any transaction opens.
 */

import {
  CHANNELS,
  isEventId,
  isPersonaId,
  isRunId,
  isTaskId,
  isThreadId,
} from '@soul-harness/contracts';
import type {
  Channel,
  EventId,
  JsonObject,
  PersonaId,
  RunId,
  TaskId,
  ThreadId,
} from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { TaskRow, TaskState } from '../types/rows.js';
import { TASK_STATES } from '../types/rows.js';
import { JSON_SCHEMA_IDS, assertLimit, decodeOptionalJson, encodeOptionalJson } from './shared.js';

const COLUMNS = [
  'id',
  'persona_id',
  'kind',
  'channel',
  'state',
  'priority',
  'run_id',
  'payload_json',
  'scheduled_at',
  'started_at',
  'finished_at',
  'attempt',
].join(', ');

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_KINDS = 64;

/** References allowed in `tasks.payload_json` (DATA-MODEL §3.1). */
export interface TaskPayloadRefs {
  readonly eventId?: EventId;
  readonly threadId?: ThreadId;
}

export interface InsertQueuedTaskInput {
  readonly id: TaskId;
  readonly personaId: PersonaId;
  readonly kind: string;
  readonly channel: Channel;
  readonly priority?: number;
  readonly payloadRefs?: TaskPayloadRefs;
  readonly scheduledAt?: number | null;
}

export interface ClaimNextTaskInput {
  readonly personaId: PersonaId;
  readonly channel: Channel;
  readonly now: number;
  readonly runId: RunId;
  readonly maxAttempts: number;
  /** Kinds with a registered handler; empty means "nothing can run right now". */
  readonly kinds: readonly string[];
}

export interface CompleteTaskInput {
  readonly id: TaskId;
  readonly runId: RunId;
  readonly expectedAttempt: number;
  readonly finishedAt: number;
}

export interface FailTaskInput {
  readonly id: TaskId;
  readonly runId: RunId;
  readonly expectedAttempt: number;
  readonly maxAttempts: number;
  readonly retry: boolean;
  readonly finishedAt: number;
  readonly nextScheduledAt?: number | null;
}

export interface FailExhaustedTaskInput {
  readonly id: TaskId;
  readonly expectedState: 'queued' | 'paused';
  readonly expectedAttempt: number;
  readonly maxAttempts: number;
  readonly finishedAt: number;
}

export interface RecoverRunningTaskInput {
  readonly id: TaskId;
  readonly personaId: PersonaId;
  readonly expectedRunId: RunId;
  readonly expectedAttempt: number;
  readonly maxAttempts: number;
  readonly finishedAt: number;
}

export type TaskAttemptFilter =
  { readonly kind: 'atLeast'; readonly value: number } | { readonly kind: 'invalid' };

export interface ListTaskPageInput {
  readonly personaId: PersonaId;
  readonly state: TaskState;
  readonly afterId?: TaskId;
  readonly limit?: number;
  readonly attemptFilter?: TaskAttemptFilter;
}

export interface SetTaskStateInput {
  readonly id: TaskId;
  readonly expectedState: 'queued' | 'paused';
  readonly nextState: 'queued' | 'paused' | 'cancelled';
  /** Timestamp written to `finished_at` when the target state is `cancelled`. */
  readonly at: number;
  /** Required for `paused → queued`: the attempt must still be below the cap. */
  readonly maxAttempts?: number;
}

export interface NextDueTaskQuery {
  readonly after: number;
}

function invalid(field: string, rule: string): never {
  throw new PersistenceError('invalid_argument', `${field} ${rule}`, { details: { field } });
}

function assertSafeNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(field, 'must be a non-negative safe integer');
  }
}

function assertAttemptAtLeastOne(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(field, 'must be an integer >= 1');
  }
}

function assertAttemptAtLeastZero(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(field, 'must be a non-negative safe integer');
  }
}

function assertMaxAttempts(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    invalid('maxAttempts', 'must be an integer between 1 and 100');
  }
}

function assertPriority(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1000 || value > 1000) {
    invalid('priority', 'must be an integer between -1000 and 1000');
  }
}

function assertKind(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KIND_PATTERN.test(value)) {
    invalid('kind', 'must match ^[a-z][a-z0-9._-]{0,63}$');
  }
}

function assertKindList(value: readonly string[]): void {
  if (!Array.isArray(value)) {
    invalid('kinds', 'must be an array');
  }
  if (value.length > MAX_KINDS) {
    invalid('kinds', `must contain at most ${MAX_KINDS} entries`);
  }
  const seen = new Set<string>();
  for (const kind of value) {
    assertKind(kind);
    if (seen.has(kind)) {
      invalid('kinds', 'must not contain duplicates');
    }
    seen.add(kind);
  }
}

function assertChannel(value: unknown): asserts value is Channel {
  if (typeof value !== 'string' || !(CHANNELS as readonly string[]).includes(value)) {
    invalid('channel', `must be one of ${CHANNELS.join(', ')}`);
  }
}

function assertPayloadRefs(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('payloadRefs', 'must be a plain object');
  }
  const refs = value as Record<string, unknown>;
  for (const key of Object.keys(refs)) {
    if (key !== 'eventId' && key !== 'threadId') {
      invalid('payloadRefs', `contains unsupported key "${key}"`);
    }
  }
  if (refs['eventId'] !== undefined && !isEventId(refs['eventId'])) {
    invalid('payloadRefs.eventId', 'must be an EventId');
  }
  if (refs['threadId'] !== undefined && !isThreadId(refs['threadId'])) {
    invalid('payloadRefs.threadId', 'must be a ThreadId');
  }
}

function encodePayloadRefs(refs: TaskPayloadRefs | undefined): string | null {
  if (refs === undefined) {
    return null;
  }
  const payload: Record<string, string> = {};
  if (refs.eventId !== undefined) {
    payload['eventId'] = refs.eventId;
  }
  if (refs.threadId !== undefined) {
    payload['threadId'] = refs.threadId;
  }
  return encodeOptionalJson(JSON_SCHEMA_IDS.taskPayload, payload as JsonObject);
}

function mapTask(raw: Readonly<Record<string, unknown>>): TaskRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as TaskId,
    personaId: row['personaId'] as PersonaId,
    kind: row['kind'] as string,
    channel: row['channel'] as Channel,
    state: row['state'] as TaskState,
    priority: Number(row['priority']),
    runId: (row['runId'] as string | null) ?? null,
    payloadJson: decodeOptionalJson(
      'payload_json',
      JSON_SCHEMA_IDS.taskPayload,
      row['payloadJson'],
    ),
    scheduledAt: row['scheduledAt'] === null ? null : Number(row['scheduledAt']),
    startedAt: row['startedAt'] === null ? null : Number(row['startedAt']),
    finishedAt: row['finishedAt'] === null ? null : Number(row['finishedAt']),
    attempt: Number(row['attempt']),
  };
}

function selectById(source: StatementSource, id: TaskId): TaskRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapTask(raw);
}

export function createTaskRepository(store: Store) {
  return {
    /**
     * Creates a task in the only legal initial state: `queued`, attempt 0, no
     * `run_id`, and no start/finish timestamps.
     */
    insertQueuedTask(input: InsertQueuedTaskInput): TaskRow {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      if (!isPersonaId(input.personaId)) {
        invalid('personaId', 'must be a PersonaId');
      }
      assertKind(input.kind);
      assertChannel(input.channel);
      const priority = input.priority ?? 0;
      assertPriority(priority);
      assertPayloadRefs(input.payloadRefs);
      const scheduledAt = input.scheduledAt ?? null;
      if (scheduledAt !== null) {
        assertSafeNonNegative(scheduledAt, 'scheduledAt');
      }

      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO tasks
             (id, persona_id, kind, channel, state, priority, payload_json, scheduled_at, attempt)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0)`,
        ).run(
          input.id,
          input.personaId,
          input.kind,
          input.channel,
          priority,
          encodePayloadRefs(input.payloadRefs),
          scheduledAt,
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('task insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: TaskId): TaskRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /**
     * Atomically claims the next runnable task and starts its run.
     *
     * One statement: `attempt` becomes `attempt + 1`, `run_id` becomes the new
     * run, `started_at` becomes `now`, `finished_at` is cleared. The candidate
     * must be queued, due, on the requested channel, of a kind with a registered
     * handler, below the attempt cap, and owned by a `RUNNING` persona.
     */
    claimNext(input: ClaimNextTaskInput): TaskRow | null {
      if (!isPersonaId(input.personaId)) {
        invalid('personaId', 'must be a PersonaId');
      }
      assertChannel(input.channel);
      assertSafeNonNegative(input.now, 'now');
      if (!isRunId(input.runId)) {
        invalid('runId', 'must be a RunId');
      }
      assertMaxAttempts(input.maxAttempts);
      assertKindList(input.kinds);

      if (input.kinds.length === 0) {
        // Nothing can run: return without touching the database at all.
        return null;
      }

      const placeholders = input.kinds.map(() => '?').join(', ');

      return withWrite(store, (tx) => {
        const rows = allRows<Record<string, unknown>>(
          tx.prepare(
            `UPDATE tasks
                SET state = 'running', attempt = attempt + 1,
                    run_id = ?, started_at = ?, finished_at = NULL
              WHERE id = (
                SELECT id FROM tasks
                 WHERE persona_id = ? AND channel = ? AND state = 'queued'
                   AND (scheduled_at IS NULL OR scheduled_at <= ?)
                   AND typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= ?
                   AND attempt < ?
                   AND kind IN (${placeholders})
                   AND EXISTS (
                     SELECT 1 FROM personas p
                      WHERE p.id = tasks.persona_id AND p.state = 'RUNNING'
                   )
                 ORDER BY priority DESC, scheduled_at IS NULL, scheduled_at, id
                 LIMIT 1
              )
              AND state = 'queued'
              AND typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= ?
              RETURNING id`,
          ),
          input.runId,
          input.now,
          input.personaId,
          input.channel,
          input.now,
          MAX_SAFE,
          input.maxAttempts,
          ...input.kinds,
          MAX_SAFE,
        );

        const claimed = rows[0]?.['id'];
        return claimed === undefined ? null : selectById(tx, claimed as TaskId);
      });
    },

    /** Completes a running task; only the run that holds it may finish it. */
    completeTask(input: CompleteTaskInput): TaskRow | null {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      if (!isRunId(input.runId)) {
        invalid('runId', 'must be a RunId');
      }
      assertAttemptAtLeastOne(input.expectedAttempt, 'expectedAttempt');
      assertSafeNonNegative(input.finishedAt, 'finishedAt');

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE tasks
                SET state = 'done', finished_at = ?
              WHERE id = ? AND state = 'running' AND run_id = ? AND attempt = ?`,
          )
          .run(input.finishedAt, input.id, input.runId, input.expectedAttempt).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * Ends a running task as failed, or requeues it for another attempt.
     *
     * The retry decision is **not** taken from the caller alone: the SQL keeps
     * `attempt < maxAttempts` in the guard, so once the cap is reached the row
     * becomes `failed` even if `retry` is true.
     */
    failTask(input: FailTaskInput): TaskRow | null {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      if (!isRunId(input.runId)) {
        invalid('runId', 'must be a RunId');
      }
      assertAttemptAtLeastOne(input.expectedAttempt, 'expectedAttempt');
      assertMaxAttempts(input.maxAttempts);
      if (typeof input.retry !== 'boolean') {
        invalid('retry', 'must be a boolean');
      }
      assertSafeNonNegative(input.finishedAt, 'finishedAt');
      const nextScheduledAt = input.nextScheduledAt ?? null;
      if (nextScheduledAt !== null) {
        assertSafeNonNegative(nextScheduledAt, 'nextScheduledAt');
      }

      const retry = input.retry ? 1 : 0;

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE tasks
                SET state        = CASE WHEN ? = 1 AND attempt < ? THEN 'queued' ELSE 'failed' END,
                    finished_at  = CASE WHEN ? = 1 AND attempt < ? THEN NULL ELSE ? END,
                    scheduled_at = CASE WHEN ? = 1 AND attempt < ? THEN ? ELSE scheduled_at END
              WHERE id = ? AND state = 'running' AND run_id = ? AND attempt = ?`,
          )
          .run(
            retry,
            input.maxAttempts,
            retry,
            input.maxAttempts,
            input.finishedAt,
            retry,
            input.maxAttempts,
            nextScheduledAt,
            input.id,
            input.runId,
            input.expectedAttempt,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * Fails a task that can never run again because its attempt already reached
     * the cap while it sat in `queued` or `paused` (e.g. the policy was lowered).
     */
    failExhaustedTask(input: FailExhaustedTaskInput): TaskRow | null {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      if (input.expectedState !== 'queued' && input.expectedState !== 'paused') {
        invalid('expectedState', "must be 'queued' or 'paused'");
      }
      assertAttemptAtLeastZero(input.expectedAttempt, 'expectedAttempt');
      assertMaxAttempts(input.maxAttempts);
      assertSafeNonNegative(input.finishedAt, 'finishedAt');

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE tasks
                SET state = 'failed', finished_at = ?
              WHERE id = ? AND state = ?
                AND attempt = ?
                AND typeof(attempt) = 'integer' AND attempt >= ?`,
          )
          .run(
            input.finishedAt,
            input.id,
            input.expectedState,
            input.expectedAttempt,
            input.maxAttempts,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * Converges a task left `running` by a crashed process.
     *
     * Persona-scoped and run-scoped CAS: the row must still be `running`, belong
     * to `personaId`, carry the expected `run_id` and `attempt`. The target state
     * is decided by the cap inside the same statement — below it the task is
     * requeued **without** bumping `attempt` (the interrupted run was already
     * counted at claim time), at or above it the task becomes `failed`.
     */
    recoverRunningTask(input: RecoverRunningTaskInput): TaskRow | null {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      if (!isPersonaId(input.personaId)) {
        invalid('personaId', 'must be a PersonaId');
      }
      if (!isRunId(input.expectedRunId)) {
        invalid('expectedRunId', 'must be a RunId');
      }
      assertAttemptAtLeastOne(input.expectedAttempt, 'expectedAttempt');
      assertMaxAttempts(input.maxAttempts);
      assertSafeNonNegative(input.finishedAt, 'finishedAt');

      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE tasks
                SET state       = CASE WHEN attempt < ? THEN 'queued' ELSE 'failed' END,
                    finished_at = CASE WHEN attempt < ? THEN NULL ELSE ? END
              WHERE id = ? AND persona_id = ? AND state = 'running'
                AND run_id = ? AND attempt = ?
                AND typeof(attempt) = 'integer' AND attempt >= 1 AND attempt <= ?`,
          )
          .run(
            input.maxAttempts,
            input.maxAttempts,
            input.finishedAt,
            input.id,
            input.personaId,
            input.expectedRunId,
            input.expectedAttempt,
            MAX_SAFE,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /**
     * The only queued/paused transitions: `queued ↔ paused`, and either of them
     * to `cancelled`. `paused → queued` additionally requires the attempt to be
     * valid and below the cap, so a resumed task is always claimable.
     */
    setTaskState(input: SetTaskStateInput): TaskRow | null {
      if (!isTaskId(input.id)) {
        invalid('id', 'must be a TaskId');
      }
      const pair = `${input.expectedState}->${input.nextState}`;
      const allowed =
        pair === 'queued->paused' ||
        pair === 'paused->queued' ||
        pair === 'queued->cancelled' ||
        pair === 'paused->cancelled';
      if (!allowed) {
        invalid('expectedState/nextState', `transition ${pair} is not allowed`);
      }
      assertSafeNonNegative(input.at, 'at');

      let resumeAttemptCap: number | undefined;
      if (pair === 'paused->queued') {
        assertMaxAttempts(input.maxAttempts);
        resumeAttemptCap = input.maxAttempts;
      }
      const attemptCap = resumeAttemptCap ?? 0;

      return withWrite(store, (tx) => {
        const changes =
          pair === 'queued->paused'
            ? tx
                .prepare(
                  `UPDATE tasks SET state = 'paused', finished_at = NULL
                    WHERE id = ? AND state = 'queued'`,
                )
                .run(input.id).changes
            : pair === 'paused->queued'
              ? tx
                  .prepare(
                    `UPDATE tasks SET state = 'queued', finished_at = NULL
                      WHERE id = ? AND state = 'paused'
                        AND typeof(attempt) = 'integer'
                        AND attempt >= 0 AND attempt <= ? AND attempt < ?`,
                  )
                  .run(input.id, MAX_SAFE, attemptCap).changes
              : tx
                  .prepare(
                    `UPDATE tasks SET state = 'cancelled', finished_at = ?
                      WHERE id = ? AND state = ?`,
                  )
                  .run(input.at, input.id, input.expectedState).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /** Uses `ix_tasks_persona_state`; ordered by primary key for keyset paging. */
    listByPersonaState(input: {
      readonly personaId: PersonaId;
      readonly state: TaskState;
      readonly limit?: number;
    }): readonly TaskRow[] {
      const bounded = assertLimit(input.limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM tasks
           WHERE persona_id = ? AND state = ?
           ORDER BY scheduled_at IS NULL, scheduled_at, id
           LIMIT ?`,
        ),
        input.personaId,
        input.state,
        bounded,
      );
      return rows.map(mapTask);
    },

    /**
     * Keyset page over one persona and state, with an optional attempt filter.
     *
     * `atLeast` only matches valid attempts (`typeof = 'integer'`, `0..MAX_SAFE`),
     * so a fractional value can never be pulled into the exhausted sweep;
     * `invalid` matches exactly the rows `claimNext` can never claim.
     */
    listPageByPersonaState(input: ListTaskPageInput): readonly TaskRow[] {
      if (!isPersonaId(input.personaId)) {
        invalid('personaId', 'must be a PersonaId');
      }
      if (!(TASK_STATES as readonly string[]).includes(input.state)) {
        invalid('state', 'must be a TaskState');
      }
      if (input.afterId !== undefined && !isTaskId(input.afterId)) {
        invalid('afterId', 'must be a TaskId');
      }
      const bounded = assertLimit(input.limit);

      const filter = input.attemptFilter;
      let filterSql = '';
      const filterParams: number[] = [];
      if (filter !== undefined) {
        if (filter.kind === 'atLeast') {
          assertSafeNonNegative(filter.value, 'attemptFilter.value');
          filterSql =
            " AND typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= ? AND attempt >= ?";
          filterParams.push(MAX_SAFE, filter.value);
        } else if (filter.kind === 'invalid') {
          filterSql = " AND NOT (typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= ?)";
          filterParams.push(MAX_SAFE);
        } else {
          invalid('attemptFilter.kind', "must be 'atLeast' or 'invalid'");
        }
      }

      const afterSql = input.afterId === undefined ? '' : ' AND id > ?';
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM tasks
           WHERE persona_id = ? AND state = ?${afterSql}${filterSql}
           ORDER BY id ASC
           LIMIT ?`,
        ),
        input.personaId,
        input.state,
        ...(input.afterId === undefined ? [] : [input.afterId]),
        ...filterParams,
        bounded,
      );
      return rows.map(mapTask);
    },

    /**
     * Earliest scheduled time still ahead of `after` among claimable rows, or
     * `null` when nothing is scheduled in the future.
     */
    nextDueAt(query: NextDueTaskQuery): number | null {
      assertSafeNonNegative(query.after, 'after');
      const raw = oneRow<{ due: number | null }>(
        readDatabaseOf(store).prepare(
          `SELECT MIN(scheduled_at) AS due FROM tasks
            WHERE state = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at > ?
              AND typeof(attempt) = 'integer' AND attempt >= 0 AND attempt <= ?`,
        ),
        query.after,
        MAX_SAFE,
      );
      if (raw === undefined || raw.due === null) {
        return null;
      }
      return Number(raw.due);
    },
  };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
