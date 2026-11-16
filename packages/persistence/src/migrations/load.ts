/**
 * Migration loading.
 *
 * Rules encoded here come from DATA-MODEL.md §8 and §1:
 *   - file name shape `NNNN_<snake_desc>.sql`
 *   - versions are unique; ordering is by version, never by directory order
 *   - the checksum is computed over LF-normalized text so a CRLF checkout on
 *     Windows cannot masquerade as a modified migration
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PersistenceError } from '../errors.js';
import type { MigrationFile } from './types.js';

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** Normalizes CRLF/CR to LF. Checksums and execution both use this form. */
export function normalizeSqlText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** SHA-256 (hex) of the normalized SQL text. */
export function checksumOfSql(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function formatMigrationVersion(version: number): string {
  return String(version).padStart(4, '0');
}

/** Builds a `MigrationFile` from raw parts; used by the loader and by tooling. */
export function createMigrationFile(
  version: number,
  name: string,
  file: string,
  rawSql: string,
): MigrationFile {
  if (!Number.isInteger(version) || version < 1 || version > 9999) {
    throw new PersistenceError('migration_name_invalid', 'migration version out of range 1..9999', {
      details: { version },
    });
  }
  const sql = normalizeSqlText(rawSql);
  if (sql.trim().length === 0) {
    throw new PersistenceError('migration_name_invalid', 'migration file is empty', {
      details: { version, name },
    });
  }
  return { version, name, file, sql, checksum: checksumOfSql(sql) };
}

/**
 * Reads every `NNNN_name.sql` in `dir`, sorted by version.
 *
 * @throws PersistenceError `migration_name_invalid` for a malformed file name
 * @throws PersistenceError `migration_duplicate_version` for a repeated version
 */
export function loadMigrationsFromDir(dir: string): readonly MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new PersistenceError('migration_not_found', 'migrations directory could not be read', {
      cause: error,
      details: { dir },
    });
  }

  const migrations: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.sql')) {
      continue;
    }
    const match = MIGRATION_FILE_PATTERN.exec(entry);
    if (match === null) {
      throw new PersistenceError(
        'migration_name_invalid',
        `migration file name is not NNNN_name.sql`,
        {
          details: { file: entry },
        },
      );
    }

    const version = Number(match[1]);
    const name = match[2] as string;
    const previous = seen.get(version);
    if (previous !== undefined) {
      throw new PersistenceError(
        'migration_duplicate_version',
        'two migration files share a version',
        {
          details: { version, first: previous, second: entry },
        },
      );
    }
    seen.set(version, entry);

    const path = join(dir, entry);
    const raw = readFileSync(path, 'utf8');
    migrations.push(createMigrationFile(version, name, path, raw));
  }

  migrations.sort((left, right) => left.version - right.version);
  return migrations;
}
