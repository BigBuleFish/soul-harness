/**
 * @soul-harness/persistence — SQLite storage foundation.
 *
 * What this package IS:
 *   - store lifecycle (open / close) with the documented pragmas
 *   - migrations: loading, checksum verification, transactional execution
 *   - schema verification against the expected P1 shape
 *   - (later batches) transactions, repositories, field mapping, checkpoints
 *
 * What this package is NOT and must never become:
 *   - no business semantics: it never decides whether an event matters, whether
 *     something should be remembered, or what the persona should do
 *   - no Archive access, no Archive keys, no decryption
 *   - no direct exposure of the SQLite handle to other packages
 *   - no raw stimulus content in any long-lived table
 */

export { openStore } from './db/open-store.js';
export type { OpenStoreOptions } from './db/open-store.js';
export { Store } from './db/store.js';

export { PERSISTENCE_ERROR_CODES, PersistenceError, isPersistenceError } from './errors.js';
export type { PersistenceErrorCode } from './errors.js';

export { defaultMigrationsDir, migrate, verifySchema } from './migrations/migrator.js';
export { checksumOfSql, loadMigrationsFromDir, normalizeSqlText } from './migrations/load.js';
export { P1_INDEXES, P1_TABLE_COLUMNS } from './migrations/expected-schema.js';
export type { P1TableName } from './migrations/expected-schema.js';
export type {
  AppliedMigration,
  MigrateOptions,
  MigrateResult,
  MigrationFile,
} from './migrations/types.js';
