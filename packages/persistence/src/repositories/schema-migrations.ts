/**
 * schema_migrations — read-only projection.
 *
 * The migration runner is the ONLY writer of this table (it owns the checksum
 * contract and the transaction that pairs DDL with its tracking row). Exposing
 * an insert/update here would create a second bookkeeping entry point and make
 * "what has been applied" ambiguous, so this repository deliberately has no
 * write method at all.
 */

import { allRows, oneRow } from '../db/rows.js';
import { databaseOf, type Store } from '../db/store.js';
import { camelizeRow } from '../mapping.js';
import type { AppliedMigrationRow } from '../types/rows.js';

const COLUMNS = 'version, name, checksum, applied_at';

function mapApplied(raw: Readonly<Record<string, unknown>>): AppliedMigrationRow {
  const row = camelizeRow<Record<string, unknown>>(raw);
  return {
    version: Number(row['version']),
    name: row['name'] as string,
    checksum: row['checksum'] as string,
    appliedAt: Number(row['appliedAt']),
  };
}

export function createSchemaMigrationsRepository(store: Store) {
  return {
    listApplied(): readonly AppliedMigrationRow[] {
      const rows = allRows<Record<string, unknown>>(
        databaseOf(store).prepare(`SELECT ${COLUMNS} FROM schema_migrations ORDER BY version`),
      );
      return rows.map(mapApplied);
    },

    getLatest(): AppliedMigrationRow | null {
      const raw = oneRow<Record<string, unknown>>(
        databaseOf(store).prepare(
          `SELECT ${COLUMNS} FROM schema_migrations ORDER BY version DESC LIMIT 1`,
        ),
      );
      return raw === undefined ? null : mapApplied(raw);
    },
  };
}

export type SchemaMigrationsRepository = ReturnType<typeof createSchemaMigrationsRepository>;
