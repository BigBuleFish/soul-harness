/**
 * Row types for the P1 tables.
 *
 * Naming: camelCase, matching the API surface (DATA-MODEL §1). Identifiers reuse
 * the branded types from `@soul-harness/contracts` so a `PersonaId` cannot be
 * passed where an `EventId` is expected.
 *
 * Trust note: these types describe what the database contains. Repositories do
 * not re-validate identifier *format* on read — rows are written through
 * validated paths, and the database is storage, not an authentication boundary.
 * Contracts validation happens at the ingress edge.
 *
 * Gap note: `contracts` defines the event-lifecycle enums (`EventStatus`,
 * `AttentionOutcome`, `ArchiveState`, `ArchiveDisposition`, `StatusReason`,
 * `Channel`) and this package reuses them. `PersonaState` and `TaskState` are
 * **not** in contracts today, so they are defined here from the DATA-MODEL §3
 * CHECK lists; moving them into contracts is a contract change for a later stage.
 */

import type {
  AdapterId,
  ArchiveDisposition,
  ArchiveRef,
  ArchiveState,
  AttentionOutcome,
  BootId,
  Channel,
  EventId,
  EventStatus,
  JsonObject,
  PersonaId,
  SessionId,
  SourceId,
  StatusReason,
  TaskId,
} from '@soul-harness/contracts';

/** DATA-MODEL §3 `personas.state` CHECK list (also RUNTIME-LIFECYCLE §5). */
export const PERSONA_STATES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'SUSPENDED',
  'STOPPING',
  'STOPPED',
  'FAILED',
] as const;

export type PersonaState = (typeof PERSONA_STATES)[number];

/** DATA-MODEL §3 `tasks.state` CHECK list. */
export const TASK_STATES = ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface PersonaRow {
  readonly id: PersonaId;
  readonly displayName: string;
  readonly state: PersonaState;
  readonly version: number;
  readonly epoch: number;
  readonly bootId: BootId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionRow {
  readonly id: SessionId;
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly externalId: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly metaJson: JsonObject | null;
}

export interface EventRow {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly sessionId: SessionId | null;
  readonly source: SourceId;
  readonly adapterId: AdapterId;
  readonly adapterEventRef: string;
  readonly status: EventStatus;
  readonly attentionOutcome: AttentionOutcome | null;
  readonly salience: number;
  readonly summary: string | null;
  readonly archiveRef: ArchiveRef | null;
  readonly receivedAt: number;
  readonly occurredAt: number | null;
  readonly updatedAt: number;
  readonly archiveDisposition: ArchiveDisposition | null;
  readonly archiveState: ArchiveState;
  readonly statusReason: StatusReason | null;
}

export interface TaskRow {
  readonly id: TaskId;
  readonly personaId: PersonaId;
  readonly kind: string;
  readonly channel: Channel;
  readonly state: TaskState;
  readonly priority: number;
  readonly runId: string | null;
  readonly payloadJson: JsonObject | null;
  readonly scheduledAt: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly attempt: number;
}

export interface RuntimeStateRow {
  readonly personaId: PersonaId;
  readonly state: string;
  readonly bootId: BootId | null;
  readonly epoch: number;
  readonly updatedAt: number;
}

/** Read-only projection of `schema_migrations`; writes belong to the migrator. */
export interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}
