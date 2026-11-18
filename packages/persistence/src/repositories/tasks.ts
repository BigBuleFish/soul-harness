/**
 * tasks repository.
 *
 * `payload_json` is wrapped with a shape version (DATA-MODEL §1) and may only
 * carry references —the repository cannot enforce that, but it refuses to store
 * a JSON column whose schema marker it did not write itself.
 */

import type { Channel, JsonObject, PersonaId, TaskId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { TaskRow, TaskState } from '../types/rows.js';
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

export interface InsertTaskInput {
  readonly id: TaskId;
  readonly personaId: PersonaId;
  readonly kind: string;
  readonly channel: Channel;
  readonly state: TaskState;
  readonly priority?: number;
  readonly runId?: string | null;
  readonly payloadJson?: JsonObject | null;
  readonly scheduledAt?: number | null;
  readonly attempt?: number;
}

export interface UpdateTaskStateInput {
  readonly id: TaskId;
  readonly state: TaskState;
  /** Explicit values only: `null` clears the column, it never means "keep". */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly attempt: number;
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
    insert(input: InsertTaskInput): TaskRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO tasks
             (id, persona_id, kind, channel, state, priority, run_id, payload_json, scheduled_at, attempt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.personaId,
          input.kind,
          input.channel,
          input.state,
          input.priority ?? 0,
          input.runId ?? null,
          encodeOptionalJson(JSON_SCHEMA_IDS.taskPayload, input.payloadJson),
          input.scheduledAt ?? null,
          input.attempt ?? 0,
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

    /** Returns the updated row, or null when no task has that id. */
    updateState(input: UpdateTaskStateInput): TaskRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE tasks
             SET state = ?, started_at = ?, finished_at = ?, attempt = ?
             WHERE id = ?`,
          )
          .run(input.state, input.startedAt, input.finishedAt, input.attempt, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    /** Uses `ix_tasks_persona_state`. */
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
  };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
