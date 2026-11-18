/**
 * runtime_state repository.
 *
 * One row per persona (primary key). `checkpoint_json` is deliberately NOT
 * touched here: checkpoint saving/loading is batch C's surface, and letting a
 * generic upsert write that column would create a second way into the same
 * storage that the checkpoint validator is supposed to protect.
 */

import type { BootId, PersonaId } from '@soul-harness/contracts';

import { oneRow } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { RuntimeStateRow } from '../types/rows.js';

const COLUMNS = 'persona_id, state, boot_id, epoch, updated_at';

export interface UpsertRuntimeStateInput {
  readonly personaId: PersonaId;
  /** Lifecycle state name from RUNTIME-LIFECYCLE §2 (free text by design). */
  readonly state: string;
  readonly bootId?: BootId | null;
  readonly epoch: number;
  readonly updatedAt: number;
}

function mapRuntimeState(raw: Readonly<Record<string, unknown>>): RuntimeStateRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    personaId: row['personaId'] as PersonaId,
    state: row['state'] as string,
    bootId: (row['bootId'] as BootId | null) ?? null,
    epoch: Number(row['epoch']),
    updatedAt: Number(row['updatedAt']),
  };
}

export function createRuntimeStateRepository(store: Store) {
  return {
    /**
     * Inserts or replaces the lifecycle row for a persona.
     *
     * `checkpoint_json` is not in the statement, so an existing checkpoint
     * survives an upsert untouched.
     */
    upsert(input: UpsertRuntimeStateInput): RuntimeStateRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO runtime_state (persona_id, state, boot_id, epoch, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(persona_id) DO UPDATE SET
             state = excluded.state,
             boot_id = excluded.boot_id,
             epoch = excluded.epoch,
             updated_at = excluded.updated_at`,
        ).run(input.personaId, input.state, input.bootId ?? null, input.epoch, input.updatedAt);

        const raw = oneRow<Record<string, unknown>>(
          tx.prepare(`SELECT ${COLUMNS} FROM runtime_state WHERE persona_id = ?`),
          input.personaId,
        );
        // Unreachable in practice: the row was written in this transaction.
        if (raw === undefined) {
          throw new Error('runtime_state upsert did not produce a row');
        }
        return mapRuntimeState(raw);
      });
    },

    get(personaId: PersonaId): RuntimeStateRow | null {
      const raw = oneRow<Record<string, unknown>>(
        readDatabaseOf(store).prepare(`SELECT ${COLUMNS} FROM runtime_state WHERE persona_id = ?`),
        personaId,
      );
      return raw === undefined ? null : mapRuntimeState(raw);
    },
  };
}

export type RuntimeStateRepository = ReturnType<typeof createRuntimeStateRepository>;
