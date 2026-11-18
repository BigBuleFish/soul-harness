/**
 * sessions repository.
 *
 * The partial unique index `ux_sessions_external ... WHERE closed_at IS NULL`
 * means a re-opened external session gets a NEW id: closing the old row frees
 * the mapping. `close` therefore matches only a still-open row.
 */

import type { AdapterId, JsonObject, PersonaId, SessionId } from '@soul-harness/contracts';

import { allRows, oneRow, type StatementSource } from '../db/rows.js';
import { readDatabaseOf } from '../db/read.js';
import type { Store } from '../db/store.js';
import { camelizeRow } from '../mapping.js';
import { withWrite } from '../tx/coordinator.js';
import type { SessionRow } from '../types/rows.js';
import { JSON_SCHEMA_IDS, assertLimit, decodeOptionalJson, encodeOptionalJson } from './shared.js';

const COLUMNS = 'id, persona_id, adapter_id, external_id, opened_at, closed_at, meta_json';

export interface InsertSessionInput {
  readonly id: SessionId;
  readonly personaId: PersonaId;
  readonly adapterId: AdapterId;
  readonly externalId?: string | null;
  readonly openedAt: number;
  readonly metaJson?: JsonObject | null;
}

export interface CloseSessionInput {
  readonly id: SessionId;
  readonly closedAt: number;
}

function mapSession(raw: Readonly<Record<string, unknown>>): SessionRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    id: row['id'] as SessionId,
    personaId: row['personaId'] as PersonaId,
    adapterId: row['adapterId'] as AdapterId,
    externalId: (row['externalId'] as string | null) ?? null,
    openedAt: Number(row['openedAt']),
    closedAt: row['closedAt'] === null ? null : Number(row['closedAt']),
    metaJson: decodeOptionalJson('meta_json', JSON_SCHEMA_IDS.sessionMeta, row['metaJson']),
  };
}

function selectById(source: StatementSource, id: SessionId): SessionRow | null {
  const raw = oneRow<Record<string, unknown>>(
    source.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`),
    id,
  );
  return raw === undefined ? null : mapSession(raw);
}

export function createSessionRepository(store: Store) {
  return {
    insert(input: InsertSessionInput): SessionRow {
      return withWrite(store, (tx) => {
        tx.prepare(
          `INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at, meta_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.personaId,
          input.adapterId,
          input.externalId ?? null,
          input.openedAt,
          encodeOptionalJson(JSON_SCHEMA_IDS.sessionMeta, input.metaJson),
        );

        const created = selectById(tx, input.id);
        // Unreachable in practice: the row was inserted in this transaction.
        if (created === null) {
          throw new Error('session insert did not produce a row');
        }
        return created;
      });
    },

    getById(id: SessionId): SessionRow | null {
      return selectById(readDatabaseOf(store), id);
    },

    /** Looks up the still-open mapping for an adapter-side reference. */
    findActiveByExternal(input: {
      readonly personaId: PersonaId;
      readonly adapterId: AdapterId;
      readonly externalId: string;
    }): SessionRow | null {
      const raw = oneRow<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM sessions
           WHERE persona_id = ? AND adapter_id = ? AND external_id = ? AND closed_at IS NULL
           LIMIT 1`,
        ),
        input.personaId,
        input.adapterId,
        input.externalId,
      );
      return raw === undefined ? null : mapSession(raw);
    },

    /** Closes an open session. Returns false when it was already closed. */
    close(input: CloseSessionInput): boolean {
      return withWrite(store, (tx) => {
        const changes = tx
          .prepare('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
          .run(input.closedAt, input.id).changes;
        return Number(changes) > 0;
      });
    },

    listByPersona(personaId: PersonaId, limit?: number): readonly SessionRow[] {
      const bounded = assertLimit(limit);
      const rows = allRows<Record<string, unknown>>(
        readDatabaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM sessions WHERE persona_id = ? ORDER BY opened_at DESC LIMIT ?`,
        ),
        personaId,
        bounded,
      );
      return rows.map(mapSession);
    },
  };
}

export type SessionRepository = ReturnType<typeof createSessionRepository>;
