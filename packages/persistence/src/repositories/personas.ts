/**
 * personas repository.
 *
 * `version` is bumped by the database statement (DATA-MODEL §1 / §6: every
 * committed change increments it); the repository never accepts a version from
 * the caller, so it cannot be spoofed.
 */

import { isPersonaId } from '@soul-harness/contracts';
import type { BootId, PersonaId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { PersistenceError } from '../errors.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { PersonaRow, PersonaState } from '../types/rows.js';
import { assertLimit } from './shared.js';

const COLUMNS = 'id, display_name, state, version, epoch, boot_id, created_at, updated_at';

export interface InsertPersonaInput {
  readonly id: PersonaId;
  readonly displayName: string;
  readonly state: PersonaState;
  readonly bootId?: BootId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UpdatePersonaStateInput {
  readonly id: PersonaId;
  readonly state: PersonaState;
  readonly updatedAt: number;
}

/** Keyset page request; `afterId` is the last id of the previous page. */
export interface ListPersonaPageInput {
  readonly afterId?: PersonaId;
  readonly limit?: number;
}

/** Compare-and-set request: both expectations must hold or nothing is written. */
export interface CompareAndSetPersonaStateInput {
  readonly id: PersonaId;
  readonly expectedState: PersonaState;
  readonly expectedVersion: number;
  readonly nextState: PersonaState;
  readonly updatedAt: number;
}

/**
 * Rejects a cursor that cannot be a persona id before any database access.
 *
 * Validation runs first so a malformed cursor never reaches the SQL layer and
 * never depends on store state.
 */
function assertAfterId(afterId: PersonaId | undefined): void {
  if (afterId !== undefined && !isPersonaId(afterId)) {
    throw new PersistenceError('invalid_argument', 'afterId must be a valid PersonaId', {
      details: { field: 'afterId' },
    });
  }
}

function mapPersona(raw: Readonly<Record<string, unknown>>): PersonaRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as PersonaId,
    displayName: row['displayName'] as string,
    state: row['state'] as PersonaState,
    version: Number(row['version']),
    epoch: Number(row['epoch']),
    bootId: (row['bootId'] as BootId | null) ?? null,
    createdAt: Number(row['createdAt']),
    updatedAt: Number(row['updatedAt']),
  };
}

function selectById(source: StatementSource, id: PersonaId): PersonaRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM personas WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapPersona(raw);
}

export function createPersonaRepository(store: Store) {
  return {
    insert(input: InsertPersonaInput): PersonaRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO personas (id, display_name, state, boot_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.displayName,
          input.state,
          input.bootId ?? null,
          input.createdAt,
          input.updatedAt,
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('persona insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: PersonaId): PersonaRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /** Returns the updated row, or null when no persona has that id. */
    updateState(input: UpdatePersonaStateInput): PersonaRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            'UPDATE personas SET state = ?, version = version + 1, updated_at = ? WHERE id = ?',
          )
          .run(input.state, input.updatedAt, input.id).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },

    list(limit?: number): readonly PersonaRow[] {
      const bounded = assertLimit(limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM personas ORDER BY created_at DESC LIMIT ?`,
        ),
        bounded,
      );
      return rows.map(mapPersona);
    },

    /**
     * Keyset page ordered by primary key.
     *
     * The cursor and the ORDER BY use the same value (`id`), which is unique and
     * unforgeable per row, so a page boundary can never skip or repeat a row.
     * Callers stop when fewer than `limit` rows come back. `list()` deliberately
     * sorts by `created_at` (not unique) and is therefore not pageable.
     */
    listPage(input: ListPersonaPageInput = {}): readonly PersonaRow[] {
      const bounded = assertLimit(input.limit);
      assertAfterId(input.afterId);

      const db = readDatabaseOf(store);
      const rows =
        input.afterId === undefined
          ? allRows<Record<string, unknown>>(
              db.prepare(`SELECT ${COLUMNS} FROM personas ORDER BY id ASC LIMIT ?`),
              bounded,
            )
          : allRows<Record<string, unknown>>(
              db.prepare(`SELECT ${COLUMNS} FROM personas WHERE id > ? ORDER BY id ASC LIMIT ?`),
              input.afterId,
              bounded,
            );

      return rows.map(mapPersona);
    },

    /**
     * Writes the next state only if both the state and the version still match.
     *
     * The comparison and the upgrade happen inside one statement, so a concurrent
     * state change cannot be overwritten. `version` is bumped by the statement
     * (INV-V: any committed state write increments it). Returns `null` when either
     * expectation fails — in that case nothing was written.
     */
    compareAndSetState(input: CompareAndSetPersonaStateInput): PersonaRow | null {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare(
            `UPDATE personas
                SET state = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND state = ? AND version = ?`,
          )
          .run(
            input.nextState,
            input.updatedAt,
            input.id,
            input.expectedState,
            input.expectedVersion,
          ).changes;

        return Number(changes) === 0 ? null : selectById(tx, input.id);
      });
    },
  };
}

export type PersonaRepository = ReturnType<typeof createPersonaRepository>;
