/**
 * checkpoint repository.
 *
 * Owns `runtime_state.checkpoint_json` exclusively (DATA-MODEL §3: that column
 * is the only place a checkpoint lives). The generic `runtime_state` repository
 * never touches it, and this repository never touches the lifecycle columns —
 * each writer owns one half of the row, which is why interleaved updates cannot
 * clobber each other.
 *
 * Transaction rules follow SH-006B: every write goes through `withWrite`, every
 * read through `withRead`, and no handle escapes the callback.
 *
 * Deliberately absent: `clear()`. The architecture defines *discarding* a stale
 * checkpoint at restore time (RUNTIME-LIFECYCLE §4), not deleting stored ones,
 * so adding a delete API would invent policy this batch is not authorised to
 * decide.
 */

import type { PersonaId } from '@soul-harness/contracts';

import { oneRow } from '../db/rows.js';
import type { Store } from '../db/store.js';
import {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  decodeCheckpoint,
  encodeCheckpoint,
  type Checkpoint,
  type CheckpointRefs,
} from '../checkpoint/format.js';
import { PersistenceError } from '../errors.js';
import { withRead, withWrite } from '../tx/coordinator.js';

/** A checkpoint as read back, with the row timestamp that last changed it. */
export interface StoredCheckpoint {
  readonly checkpoint: Checkpoint;
  /** `runtime_state.updated_at` at the time the checkpoint was written. */
  readonly savedAt: number;
}

/**
 * Outcome of a load.
 *
 * `absent` and `stale` are expected states and are returned, not thrown:
 * a caller restoring a persona must be able to tell "nothing to restore" apart
 * from "there is a checkpoint but it predates the current epoch".
 * Corruption and unsupported versions throw instead — those are faults.
 */
export type CheckpointLoadResult =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly stored: StoredCheckpoint }
  | {
      readonly status: 'stale';
      readonly checkpointEpoch: number;
      readonly currentEpoch: number;
    };

export interface SaveCheckpointInput {
  readonly personaId: PersonaId;
  /** Must equal the persona's current `runtime_state.epoch`. */
  readonly epoch: number;
  readonly refs?: CheckpointRefs;
  readonly updatedAt: number;
}

interface RuntimeStateSnapshot {
  readonly epoch: number;
  readonly checkpoint_json: string | null;
  readonly updated_at: number;
}

const SNAPSHOT_SQL =
  'SELECT epoch, checkpoint_json, updated_at FROM runtime_state WHERE persona_id = ?';

function assertTimestamp(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PersistenceError('invalid_argument', 'updatedAt must be a non-negative integer');
  }
}

export function createCheckpointRepository(store: Store) {
  return {
    /**
     * Reads the persona's current checkpoint.
     *
     * Runs inside `withRead`, so it joins an outer transaction when one is open
     * and sees that transaction's uncommitted checkpoint.
     */
    load(personaId: PersonaId): CheckpointLoadResult {
      return withRead(store, (tx) => {
        const row = oneRow<RuntimeStateSnapshot>(tx.prepare(SNAPSHOT_SQL), personaId);

        if (row === undefined || row.checkpoint_json === null) {
          return { status: 'absent' } as const;
        }

        const checkpoint = decodeCheckpoint(row.checkpoint_json);
        const currentEpoch = Number(row.epoch);

        if (checkpoint.epoch < currentEpoch) {
          return {
            status: 'stale',
            checkpointEpoch: checkpoint.epoch,
            currentEpoch,
          } as const;
        }
        if (checkpoint.epoch > currentEpoch) {
          throw new PersistenceError(
            'checkpoint_epoch_mismatch',
            'stored checkpoint epoch is ahead of the persona epoch',
            { details: { column: 'checkpoint_json' } },
          );
        }

        return {
          status: 'present',
          stored: { checkpoint, savedAt: Number(row.updated_at) },
        } as const;
      });
    },

    /**
     * Replaces the persona's checkpoint atomically.
     *
     * The payload is validated before the transaction opens, so a rejected value
     * never reaches SQL. The update is a single statement inside `withWrite`:
     * it either lands completely or not at all, and a failure leaves the previous
     * checkpoint untouched.
     */
    save(input: SaveCheckpointInput): StoredCheckpoint {
      assertTimestamp(input.updatedAt);
      const encoded = encodeCheckpoint(input.epoch, input.refs);

      return withWrite(store, (tx) => {
        const row = oneRow<RuntimeStateSnapshot>(tx.prepare(SNAPSHOT_SQL), input.personaId);

        if (row === undefined) {
          throw new PersistenceError(
            'runtime_state_missing',
            'cannot store a checkpoint without a runtime_state row',
            { details: { column: 'checkpoint_json' } },
          );
        }

        const currentEpoch = Number(row.epoch);
        if (currentEpoch !== input.epoch) {
          throw new PersistenceError(
            'checkpoint_epoch_mismatch',
            'checkpoint epoch does not match the persona runtime epoch',
            { details: { column: 'epoch' } },
          );
        }

        tx.prepare(
          'UPDATE runtime_state SET checkpoint_json = ?, updated_at = ? WHERE persona_id = ?',
        ).run(encoded, input.updatedAt, input.personaId);

        return {
          checkpoint: decodeCheckpoint(encoded),
          savedAt: input.updatedAt,
        };
      });
    },
  };
}

export type CheckpointRepository = ReturnType<typeof createCheckpointRepository>;

/** Re-exported so callers can build/verify envelopes without importing internals. */
export { CHECKPOINT_SCHEMA, CHECKPOINT_VERSION, decodeCheckpoint, encodeCheckpoint };
export type { Checkpoint, CheckpointRefs };
