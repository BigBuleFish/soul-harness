/**
 * Migration value types.
 *
 * A `MigrationFile` is the *loaded and verified* form of a `NNNN_name.sql` file:
 * SQL text normalized to LF and the SHA-256 of that normalized text. The
 * checksum is what makes "already applied" verifiable rather than trusted.
 */

export interface MigrationFile {
  /** Numeric prefix, 1..9999. */
  readonly version: number;
  /** snake_case description taken from the file name. */
  readonly name: string;
  /** Absolute path of the source file. */
  readonly file: string;
  /** File content with CRLF/CR normalized to LF. */
  readonly sql: string;
  /** SHA-256 (hex) of `sql`. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export interface MigrateOptions {
  /**
   * Directory to load migrations from. Defaults to the package's own
   * `migrations/` directory. Tests point this at a temp directory so the real
   * loader and the real execution path handle synthetic cases.
   */
  readonly dir?: string;
  /** Pre-loaded migrations; takes precedence over `dir`. */
  readonly migrations?: readonly MigrationFile[];
}

export interface MigrateResult {
  /** Versions applied by this call, ascending. */
  readonly applied: readonly number[];
  /** Versions already present and verified, ascending. */
  readonly alreadyApplied: readonly number[];
  /** Highest applied version after the call (0 on an empty database). */
  readonly currentVersion: number;
}
