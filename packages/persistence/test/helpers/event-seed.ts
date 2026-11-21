/**
 * TEST-ONLY event fixture (never exported from the package entry point).
 *
 * Production creates events exclusively through `events.commitP1Envelope()`
 * (plus the P1 terminal transitions). Tests still need to arrange rows in states
 * the production API intentionally cannot reach — including `acted` — so this
 * helper writes the row with SQL under the normal `withWrite` guard.
 *
 * It deliberately bypasses the production write boundary; do not import it from
 * `src/`.
 */

import type {
  AdapterId,
  AttentionOutcome,
  EventId,
  EventStatus,
  PersonaId,
  SessionId,
  SourceId,
  StatusReason,
} from '@soul-harness/contracts';

import { createRepositories, withWrite, type EventRow, type Store } from '../../src/index.js';

export interface SeedEventInput {
  readonly id: EventId;
  readonly personaId: PersonaId;
  readonly status: EventStatus;
  readonly sessionId?: SessionId | null;
  readonly source: SourceId;
  readonly adapterId: AdapterId;
  readonly adapterEventRef: string;
  readonly attentionOutcome?: AttentionOutcome | null;
  readonly salience?: number;
  /** Required by the database CHECK for `expired` / `rejected`, NULL otherwise. */
  readonly statusReason?: StatusReason | null;
  readonly receivedAt: number;
  readonly occurredAt?: number | null;
  readonly updatedAt: number;
}

export function seedEvent(store: Store, input: SeedEventInput): EventRow {
  withWrite(store, (tx) => {
    tx.prepare(
      `INSERT INTO events
         (id, persona_id, session_id, source, adapter_id, adapter_event_ref, status,
          attention_outcome, salience, summary, status_reason, received_at, occurred_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.personaId,
      input.sessionId ?? null,
      input.source,
      input.adapterId,
      input.adapterEventRef,
      input.status,
      input.attentionOutcome ?? null,
      input.salience ?? 0,
      input.statusReason ?? null,
      input.receivedAt,
      input.occurredAt ?? null,
      input.updatedAt,
    );
  });

  const row = createRepositories(store).events.getById({
    personaId: input.personaId,
    id: input.id,
  });
  if (row === null) {
    throw new Error('seedEvent did not produce a row');
  }
  return row;
}
