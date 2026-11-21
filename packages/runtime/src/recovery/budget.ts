/**
 * Recovery budgets.
 *
 * `maxScanQueries` is derived from the other budgets when the caller does not
 * provide one. The derivation is intentionally not clamped: a caller that
 * raises `maxPersonasPerRun` / `maxRowsPerRun` gets a budget large enough to
 * finish, even when the derived value exceeds the explicit-input ceiling of
 * 1,000,000. Explicit values are validated independently in `recover.ts`.
 */

export interface ScanQueryBudgetInput {
  readonly batchSize: number;
  readonly maxPersonasPerRun: number;
  readonly maxRowsPerRun: number;
}

/** Per-persona normal-scan queries: U1, U2, U3, U4, U4b, U5×2, U6×3. */
export const PER_PERSONA_SCAN_QUERIES = 10;

/**
 * Auto-derived normal-scan budget:
 *
 *   persona pages + 10 × maxPersonasPerRun + maxRowsPerRun
 *
 * where `persona pages = ceil(maxPersonasPerRun / batchSize) + 1` (the extra
 * page is the lookahead that proves enumeration ended).
 */
export function computeDefaultMaxScanQueries(input: ScanQueryBudgetInput): number {
  const personaPages = Math.ceil(input.maxPersonasPerRun / input.batchSize) + 1;
  return personaPages + PER_PERSONA_SCAN_QUERIES * input.maxPersonasPerRun + input.maxRowsPerRun;
}
