/**
 * personas repository.
 *
 * `version` is bumped by the database statement (DATA-MODEL §1 / §6: every
 * committed change increments it); the repository never accepts a version from
 * the caller, so it cannot be spoofed.
 */

import type { BootId, PersonaId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
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
  };
}

export type PersonaRepository = ReturnType<typeof createPersonaRepository>;
