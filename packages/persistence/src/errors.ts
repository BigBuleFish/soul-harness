/**
 * Persistence error model.
 *
 * Codes are a closed set so callers can branch without string matching. Error
 * messages never embed SQL parameters, row values or stimulus content: they name
 * the operation and, at most, a migration version or a table/column identifier.
 */

export const PERSISTENCE_ERROR_CODES = [
  // store lifecycle
  'store_closed',
  'store_open_failed',
  'pragma_not_applied',
  // migrations
  'migration_name_invalid',
  'migration_duplicate_version',
  'migration_not_found',
  'migration_out_of_order',
  'migration_checksum_mismatch',
  'migration_failed',
  'schema_mismatch',
  // transactions
  'nested_write',
  'read_only_violation',
  'async_callback_unsupported',
  'transaction_closed',
  // database errors
  'unique_conflict',
  'foreign_key_violation',
  'check_violation',
  'not_null_violation',
  'db_error',
  // mapping
  'invalid_field_name',
  'invalid_column_value',
  'invalid_json_column',
  'invalid_argument',
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly details?: Readonly<Record<string, string | number>>;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, string | number>>;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PersistenceError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Narrowing helper for call sites that catch unknown errors. */
export function isPersistenceError(value: unknown): value is PersistenceError {
  return value instanceof PersistenceError;
}
