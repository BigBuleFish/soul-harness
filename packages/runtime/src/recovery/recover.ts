/**
 * P1 Runtime Recovery — bounded, provable, fail-closed.
 *
 * What it recovers:
 *   U1  leftover `running` tasks  → queued (below the cap) or failed (at it)
 *   U2  queued rows with an invalid attempt → abort (never claimable)
 *   U3  queued rows whose valid attempt reached the cap → failed
 *   U4  paused rows with an invalid attempt → abort
 *   U4b paused rows whose valid attempt reached the cap → failed
 *   U5  P1 active events (`received` / `accepted`) → expired + `buffer_lost`
 *   U6  states this build can never produce → abort
 *
 * What it must not do: scan A/B, read the Archive, restore checkpoints, run
 * migration, or claim a task. Every write goes through a persistence repository
 * with a conditional guard; every budget is checked *before* a query is issued.
 *
 * "Complete" is only reported when every remaining range was probed empty — a
 * budget stop without a successful probe is always `incomplete`.
 */

import type { EventId, EventStatus, PersonaId, RunId, TaskId } from '@soul-harness/contracts';
import { isRunId } from '@soul-harness/contracts';
import type { EventRow, Store, TaskRow } from '@soul-harness/persistence';
import { createRepositories } from '@soul-harness/persistence';

import { readClock } from '../clock.js';
import { RuntimeError } from '../errors.js';
import type { RuntimeLogger } from '../persona/lifecycle.js';
import { computeDefaultMaxScanQueries } from './budget.js';

export type RecoveryIncompleteReason =
  | 'row_budget_exceeded'
  | 'scan_query_budget_exceeded'
  | 'persona_budget_exceeded'
  | 'probe_budget_exceeded'
  | 'aborted'
  | 'archive_state_present'
  | 'unexpected_event_status'
  | 'invalid_task_row'
  | 'concurrent_modification';

export interface RecoveryIncompleteDetail {
  readonly personaId?: string;
  readonly taskId?: string;
  readonly eventId?: string;
  readonly scanned?: number;
}

export interface RecoveryIncomplete {
  readonly reason: RecoveryIncompleteReason;
  readonly detail?: RecoveryIncompleteDetail;
}

export interface RecoveryReport {
  readonly personasScanned: number;
  readonly tasks: { readonly requeued: number; readonly failed: number };
  readonly events: { readonly expired: number };
  readonly incomplete: RecoveryIncomplete | null;
}

/**
 * The subset of the scheduler policy recovery uses.
 *
 * The assembly layer passes the *same* object to the scheduler and to recovery;
 * recovery only reads `maxAttempts` and never derives a backoff itself.
 */
export interface RecoveryPolicy {
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface RecoverRuntimeOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  readonly policy: RecoveryPolicy;
  readonly now?: () => number;
  readonly batchSize?: number;
  readonly maxRowsPerRun?: number;
  readonly maxScanQueries?: number;
  readonly maxPersonasPerRun?: number;
  readonly maxProbeQueries?: number;
  readonly signal?: AbortSignal;
}

type UnitId = 'U1' | 'U2' | 'U3' | 'U4' | 'U4b' | 'U5r' | 'U5a' | 'U6n' | 'U6u' | 'U6c';

/** Fixed scan order; one entry per query category, ten per persona. */
const UNIT_ORDER: readonly UnitId[] = [
  'U1',
  'U2',
  'U3',
  'U4',
  'U4b',
  'U5r',
  'U5a',
  'U6n',
  'U6u',
  'U6c',
];

const FAIL_CLOSED_REASONS: ReadonlySet<RecoveryIncompleteReason> = new Set([
  'invalid_task_row',
  'archive_state_present',
  'unexpected_event_status',
  'concurrent_modification',
]);

const DEFAULTS = {
  batchSize: 200,
  maxRowsPerRun: 10_000,
  maxPersonasPerRun: 200,
  maxProbeQueries: 200,
} as const;

const EXPLICIT_SCAN_QUERY_CEILING = 1_000_000;

interface ResolvedOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  readonly policy: RecoveryPolicy;
  readonly now: () => number;
  readonly batchSize: number;
  readonly maxRowsPerRun: number;
  readonly maxScanQueries: number;
  readonly maxPersonasPerRun: number;
  readonly maxProbeQueries: number;
  readonly signal?: AbortSignal;
}

interface Progress {
  done: boolean;
  cursor?: string;
}

function invalid(field: string, rule: string): never {
  throw new RuntimeError('invalid_argument', `${field} ${rule}`, { details: { field } });
}

function intInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(field, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function resolveOptions(options: RecoverRuntimeOptions): ResolvedOptions {
  if (typeof options !== 'object' || options === null) {
    invalid('options', 'must be an object');
  }
  if (options.store === undefined || options.store === null) {
    invalid('store', 'is required');
  }
  if (options.logger === undefined || options.logger === null) {
    invalid('logger', 'is required');
  }
  const policy = options.policy;
  if (typeof policy !== 'object' || policy === null) {
    invalid('policy', 'is required');
  }
  const maxAttempts = policy.maxAttempts;
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100
  ) {
    invalid('policy.maxAttempts', 'must be an integer between 1 and 100');
  }
  const retryBackoffMs = policy.retryBackoffMs;
  if (
    typeof retryBackoffMs !== 'number' ||
    !Number.isSafeInteger(retryBackoffMs) ||
    retryBackoffMs < 0 ||
    retryBackoffMs > 86_400_000
  ) {
    invalid('policy.retryBackoffMs', 'must be a safe integer between 0 and 86400000');
  }

  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    invalid('now', 'must be a function');
  }
  // Fail before any database work when the clock is already invalid.
  readClock(now);

  const batchSize = intInRange(options.batchSize, 'batchSize', 1, 500, DEFAULTS.batchSize);
  const maxRowsPerRun = intInRange(
    options.maxRowsPerRun,
    'maxRowsPerRun',
    1,
    1_000_000,
    DEFAULTS.maxRowsPerRun,
  );
  const maxPersonasPerRun = intInRange(
    options.maxPersonasPerRun,
    'maxPersonasPerRun',
    1,
    10_000,
    DEFAULTS.maxPersonasPerRun,
  );
  const maxProbeQueries = intInRange(
    options.maxProbeQueries,
    'maxProbeQueries',
    1,
    10_000,
    DEFAULTS.maxProbeQueries,
  );

  let maxScanQueries: number;
  if (options.maxScanQueries === undefined) {
    maxScanQueries = computeDefaultMaxScanQueries({ batchSize, maxPersonasPerRun, maxRowsPerRun });
  } else {
    maxScanQueries = intInRange(
      options.maxScanQueries,
      'maxScanQueries',
      1,
      EXPLICIT_SCAN_QUERY_CEILING,
      0,
    );
  }

  const signal = options.signal;
  if (
    signal !== undefined &&
    (typeof signal !== 'object' || signal === null || typeof signal.aborted !== 'boolean')
  ) {
    invalid('signal', 'must be an AbortSignal');
  }

  return {
    store: options.store,
    logger: options.logger,
    policy: { maxAttempts, retryBackoffMs },
    now,
    batchSize,
    maxRowsPerRun,
    maxScanQueries,
    maxPersonasPerRun,
    maxProbeQueries,
    ...(signal === undefined ? {} : { signal }),
  };
}

function safeLog(
  logger: RuntimeLogger,
  level: 'debug' | 'info' | 'warn',
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Diagnostics must never change the recovery outcome.
  }
}

/**
 * Recovers leftover runtime state from a previous process.
 *
 * Runs strictly against persistence repositories; no SQL, no Archive, no
 * scheduler. Returns a report whose `incomplete` is `null` only when every
 * remaining range was proven empty.
 */
export async function recoverRuntime(options: RecoverRuntimeOptions): Promise<RecoveryReport> {
  const cfg = resolveOptions(options);
  const repos = createRepositories(cfg.store);
  const clock = (): number => readClock(cfg.now);

  const totals = { requeued: 0, failed: 0, expired: 0 };
  const state = { rows: 0, scanQueries: 0, personas: 0, probeQueries: 0 };
  const personas: PersonaId[] = [];
  const progress = new Map<string, Progress>();
  const key = (personaId: PersonaId, unit: UnitId): string => `${personaId}|${unit}`;

  let stop: RecoveryIncomplete | null = null;
  let personaEnumerationDone = false;
  let personaCursor: PersonaId | undefined;

  const aborted = (): boolean => cfg.signal?.aborted === true;
  const abort = (reason: RecoveryIncompleteReason, detail?: RecoveryIncompleteDetail): void => {
    if (stop === null) {
      stop = detail === undefined ? { reason } : { reason, detail };
    }
  };

  const takeScanQuery = (): boolean => {
    if (stop !== null) {
      return false;
    }
    if (aborted()) {
      abort('aborted');
      return false;
    }
    if (state.scanQueries >= cfg.maxScanQueries) {
      abort('scan_query_budget_exceeded');
      return false;
    }
    state.scanQueries += 1;
    return true;
  };

  const pageLimit = (): number => Math.min(cfg.batchSize, cfg.maxRowsPerRun - state.rows);

  const mark = (personaId: PersonaId, unit: UnitId, done: boolean, cursor?: string): void => {
    const entry = progress.get(key(personaId, unit));
    if (entry === undefined) {
      progress.set(key(personaId, unit), cursor === undefined ? { done } : { done, cursor });
      return;
    }
    entry.done = done;
    if (cursor !== undefined) {
      entry.cursor = cursor;
    }
  };

  const report = (incomplete: RecoveryIncomplete | null): RecoveryReport => ({
    personasScanned: state.personas,
    tasks: { requeued: totals.requeued, failed: totals.failed },
    events: { expired: totals.expired },
    incomplete,
  });

  // ---------------------------------------------------------------- enumeration

  while (!personaEnumerationDone) {
    if (stop !== null) {
      break;
    }
    if (aborted()) {
      abort('aborted');
      break;
    }
    if (!takeScanQuery()) {
      break;
    }
    const limit = pageLimit();
    if (limit <= 0) {
      abort('row_budget_exceeded');
      break;
    }
    const page = repos.personas.listPage({
      limit,
      ...(personaCursor === undefined ? {} : { afterId: personaCursor }),
    });
    state.rows += page.length;

    const allowed = cfg.maxPersonasPerRun - state.personas;
    const accepted = page.slice(0, Math.max(0, allowed));
    for (const persona of accepted) {
      personas.push(persona.id);
      for (const unit of UNIT_ORDER) {
        progress.set(key(persona.id, unit), { done: false });
      }
    }
    state.personas += accepted.length;

    if (accepted.length < page.length) {
      abort('persona_budget_exceeded');
      break;
    }
    if (page.length < limit) {
      personaEnumerationDone = true;
      break;
    }
    const last = page[page.length - 1];
    if (last === undefined) {
      personaEnumerationDone = true;
      break;
    }
    personaCursor = last.id;
    if (state.rows >= cfg.maxRowsPerRun) {
      abort('row_budget_exceeded');
      break;
    }
  }

  // ---------------------------------------------------------------- U1

  const validateRunningRow = (row: TaskRow): string | null => {
    if (row.runId === null || !isRunId(row.runId)) {
      return 'run_id';
    }
    if (typeof row.attempt !== 'number' || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
      return 'attempt';
    }
    if (!Number.isSafeInteger(row.startedAt) || Number(row.startedAt) < 0) {
      return 'started_at';
    }
    if (row.finishedAt !== null) {
      return 'finished_at';
    }
    return null;
  };

  const handleRunningRow = (personaId: PersonaId, row: TaskRow): void => {
    const invalidField = validateRunningRow(row);
    if (invalidField !== null) {
      abort('invalid_task_row', { personaId, taskId: row.id });
      return;
    }
    const result = repos.tasks.recoverRunningTask({
      id: row.id,
      personaId,
      expectedRunId: row.runId as RunId,
      expectedAttempt: row.attempt,
      maxAttempts: cfg.policy.maxAttempts,
      finishedAt: clock(),
    });
    if (result === null) {
      abort('concurrent_modification', { personaId, taskId: row.id });
      return;
    }
    if (result.state === 'queued') {
      totals.requeued += 1;
    } else {
      totals.failed += 1;
    }
  };

  // ---------------------------------------------------------------- generic paging

  /**
   * Reads one task page.
   *
   * A row whose INTEGER column exceeds `Number.MAX_SAFE_INTEGER` cannot be
   * materialized by the SQLite driver: reading it throws `RangeError` (verified
   * on Node 24). Such a row already violates the "attempt is a safe integer"
   * invariant, so it is fail-closed as `invalid_task_row` instead of escaping as
   * a driver error. Other errors are re-thrown untouched.
   */
  const readTaskPage = (
    fetch: (limit: number, afterId: TaskId | undefined) => readonly TaskRow[],
    limit: number,
    cursor: TaskId | undefined,
    personaId: PersonaId,
  ): readonly TaskRow[] | null => {
    try {
      return fetch(limit, cursor);
    } catch (error) {
      if (error instanceof RangeError) {
        abort('invalid_task_row', { personaId });
        return null;
      }
      throw error;
    }
  };

  const pageTasks = (
    personaId: PersonaId,
    unit: UnitId,
    fetch: (limit: number, afterId: TaskId | undefined) => readonly TaskRow[],
    onRow: (row: TaskRow) => void,
  ): void => {
    let cursor = progress.get(key(personaId, unit))?.cursor as TaskId | undefined;
    for (;;) {
      if (stop !== null) {
        mark(personaId, unit, false, cursor);
        return;
      }
      if (aborted()) {
        abort('aborted');
        mark(personaId, unit, false, cursor);
        return;
      }
      if (!takeScanQuery()) {
        mark(personaId, unit, false, cursor);
        return;
      }
      const limit = pageLimit();
      if (limit <= 0) {
        abort('row_budget_exceeded');
        mark(personaId, unit, false, cursor);
        return;
      }
      const page = readTaskPage(fetch, limit, cursor, personaId);
      if (page === null) {
        mark(personaId, unit, false, cursor);
        return;
      }
      state.rows += page.length;
      for (const row of page) {
        if (aborted()) {
          abort('aborted');
          mark(personaId, unit, false, cursor);
          return;
        }
        onRow(row);
        if (stop !== null) {
          mark(personaId, unit, false, cursor);
          return;
        }
        cursor = row.id;
      }
      if (page.length < limit) {
        mark(personaId, unit, true, cursor);
        return;
      }
      if (state.rows >= cfg.maxRowsPerRun) {
        abort('row_budget_exceeded');
        mark(personaId, unit, false, cursor);
        return;
      }
      mark(personaId, unit, false, cursor);
    }
  };

  const pageEvents = (
    personaId: PersonaId,
    unit: UnitId,
    fetch: (limit: number, afterId: EventId | undefined) => readonly EventRow[],
    onRow: (row: EventRow) => void,
  ): void => {
    let cursor = progress.get(key(personaId, unit))?.cursor as EventId | undefined;
    for (;;) {
      if (stop !== null) {
        mark(personaId, unit, false, cursor);
        return;
      }
      if (aborted()) {
        abort('aborted');
        mark(personaId, unit, false, cursor);
        return;
      }
      if (!takeScanQuery()) {
        mark(personaId, unit, false, cursor);
        return;
      }
      const limit = pageLimit();
      if (limit <= 0) {
        abort('row_budget_exceeded');
        mark(personaId, unit, false, cursor);
        return;
      }
      const page = fetch(limit, cursor);
      state.rows += page.length;
      for (const row of page) {
        if (aborted()) {
          abort('aborted');
          mark(personaId, unit, false, cursor);
          return;
        }
        onRow(row);
        if (stop !== null) {
          mark(personaId, unit, false, cursor);
          return;
        }
        cursor = row.id;
      }
      if (page.length < limit) {
        mark(personaId, unit, true, cursor);
        return;
      }
      if (state.rows >= cfg.maxRowsPerRun) {
        abort('row_budget_exceeded');
        mark(personaId, unit, false, cursor);
        return;
      }
      mark(personaId, unit, false, cursor);
    }
  };

  const detectEventStatus = (personaId: PersonaId, unit: UnitId, status: EventStatus): void => {
    if (stop !== null) {
      return;
    }
    if (!takeScanQuery()) {
      mark(personaId, unit, false);
      return;
    }
    const limit = pageLimit();
    if (limit <= 0) {
      abort('row_budget_exceeded');
      mark(personaId, unit, false);
      return;
    }
    const page = repos.events.listPageByPersonaStatus({
      personaId,
      status,
      limit: Math.min(1, limit),
    });
    state.rows += page.length;
    const hit = page[0];
    if (hit !== undefined) {
      abort('unexpected_event_status', { personaId, eventId: hit.id });
      mark(personaId, unit, false);
      return;
    }
    mark(personaId, unit, true);
  };

  // ---------------------------------------------------------------- per persona

  const scanPersona = (personaId: PersonaId): void => {
    if (stop !== null) {
      return;
    }

    pageTasks(
      personaId,
      'U1',
      (limit, afterId) =>
        repos.tasks.listPageByPersonaState({
          personaId,
          state: 'running',
          limit,
          ...(afterId === undefined ? {} : { afterId }),
        }),
      (row) => handleRunningRow(personaId, row),
    );

    pageTasks(
      personaId,
      'U2',
      (limit, afterId) =>
        repos.tasks.listPageByPersonaState({
          personaId,
          state: 'queued',
          limit,
          attemptFilter: { kind: 'invalid' },
          ...(afterId === undefined ? {} : { afterId }),
        }),
      (row) => {
        abort('invalid_task_row', { personaId, taskId: row.id });
      },
    );

    pageTasks(
      personaId,
      'U3',
      (limit, afterId) =>
        repos.tasks.listPageByPersonaState({
          personaId,
          state: 'queued',
          limit,
          attemptFilter: { kind: 'atLeast', value: cfg.policy.maxAttempts },
          ...(afterId === undefined ? {} : { afterId }),
        }),
      (row) => {
        const result = repos.tasks.failExhaustedTask({
          id: row.id,
          personaId,
          expectedState: 'queued',
          expectedAttempt: row.attempt,
          maxAttempts: cfg.policy.maxAttempts,
          finishedAt: clock(),
        });
        if (result === null) {
          abort('concurrent_modification', { personaId, taskId: row.id });
          return;
        }
        totals.failed += 1;
      },
    );

    pageTasks(
      personaId,
      'U4',
      (limit, afterId) =>
        repos.tasks.listPageByPersonaState({
          personaId,
          state: 'paused',
          limit,
          attemptFilter: { kind: 'invalid' },
          ...(afterId === undefined ? {} : { afterId }),
        }),
      (row) => {
        abort('invalid_task_row', { personaId, taskId: row.id });
      },
    );

    pageTasks(
      personaId,
      'U4b',
      (limit, afterId) =>
        repos.tasks.listPageByPersonaState({
          personaId,
          state: 'paused',
          limit,
          attemptFilter: { kind: 'atLeast', value: cfg.policy.maxAttempts },
          ...(afterId === undefined ? {} : { afterId }),
        }),
      (row) => {
        const result = repos.tasks.failExhaustedTask({
          id: row.id,
          personaId,
          expectedState: 'paused',
          expectedAttempt: row.attempt,
          maxAttempts: cfg.policy.maxAttempts,
          finishedAt: clock(),
        });
        if (result === null) {
          abort('concurrent_modification', { personaId, taskId: row.id });
          return;
        }
        totals.failed += 1;
      },
    );

    const expireEvent = (row: EventRow): void => {
      if (row.archiveState !== 'none') {
        abort('archive_state_present', { personaId, eventId: row.id });
        return;
      }
      const result = repos.events.expireIfActive({
        id: row.id,
        personaId,
        updatedAt: clock(),
      });
      if (result === null) {
        abort('concurrent_modification', { personaId, eventId: row.id });
        return;
      }
      totals.expired += 1;
    };

    pageEvents(
      personaId,
      'U5r',
      (limit, afterId) =>
        repos.events.listPageByPersonaStatus({
          personaId,
          status: 'received',
          limit,
          ...(afterId === undefined ? {} : { afterId }),
        }),
      expireEvent,
    );

    pageEvents(
      personaId,
      'U5a',
      (limit, afterId) =>
        repos.events.listPageByPersonaStatus({
          personaId,
          status: 'accepted',
          limit,
          ...(afterId === undefined ? {} : { afterId }),
        }),
      expireEvent,
    );

    detectEventStatus(personaId, 'U6n', 'noticed');
    detectEventStatus(personaId, 'U6u', 'understood');
    detectEventStatus(personaId, 'U6c', 'response_committed');
  };

  safeLog(cfg.logger, 'info', 'recovery_started', {
    batchSize: cfg.batchSize,
    maxRowsPerRun: cfg.maxRowsPerRun,
    maxScanQueries: cfg.maxScanQueries,
    maxPersonasPerRun: cfg.maxPersonasPerRun,
    maxProbeQueries: cfg.maxProbeQueries,
    maxAttempts: cfg.policy.maxAttempts,
  });

  if (!aborted()) {
    for (const personaId of personas) {
      if (stop !== null) {
        break;
      }
      if (aborted()) {
        abort('aborted');
        break;
      }
      scanPersona(personaId);
    }
  } else {
    abort('aborted');
  }

  // ---------------------------------------------------------------- completeness

  const planComplete =
    personaEnumerationDone &&
    personas.every((personaId) =>
      UNIT_ORDER.every((unit) => progress.get(key(personaId, unit))?.done === true),
    );

  // `stop` is only ever assigned inside closures, which the compiler does not
  // track for control-flow analysis; reading it through a function keeps the
  // declared union type instead of narrowing it to `null`.
  const pendingStop = (): RecoveryIncomplete | null => stop;

  const afterScan = pendingStop();

  if (afterScan !== null && FAIL_CLOSED_REASONS.has(afterScan.reason)) {
    safeLog(cfg.logger, 'warn', 'recovery_incomplete', { reason: afterScan.reason });
    return report(afterScan);
  }
  if (afterScan !== null && afterScan.reason === 'aborted') {
    safeLog(cfg.logger, 'warn', 'recovery_incomplete', { reason: afterScan.reason });
    return report(afterScan);
  }

  if (afterScan === null && planComplete) {
    safeLog(cfg.logger, 'info', 'recovery_completed', {
      personas: state.personas,
      requeued: totals.requeued,
      failed: totals.failed,
      expired: totals.expired,
    });
    return report(null);
  }

  // ---------------------------------------------------------------- global probe

  const failure: RecoveryIncompleteReason = afterScan?.reason ?? 'scan_query_budget_exceeded';

  const takeProbe = (): boolean => {
    if (aborted()) {
      // Cancellation during the probe overrides the earlier stop reason.
      stop = { reason: 'aborted' };
      return false;
    }
    if (state.probeQueries >= cfg.maxProbeQueries) {
      // Probe exhaustion is its own outcome, not the scan's original reason.
      stop = { reason: 'probe_budget_exceeded' };
      return false;
    }
    state.probeQueries += 1;
    return true;
  };

  /**
   * Probe-phase task read.
   *
   * The probe usually runs with `stop` already set to the budget reason that
   * ended the scan. A row the driver cannot materialize (INTEGER above
   * `Number.MAX_SAFE_INTEGER`) is a new, more specific failure, so it replaces
   * that reason — the probe must never turn a read error into "probe empty" or
   * let the earlier budget reason hide it.
   */
  const readProbeTasks = (
    personaId: PersonaId,
    read: () => readonly TaskRow[],
  ): readonly TaskRow[] | null => {
    try {
      return read();
    } catch (error) {
      if (error instanceof RangeError) {
        stop = { reason: 'invalid_task_row', detail: { personaId } };
        return null;
      }
      throw error;
    }
  };

  const probeUnit = (personaId: PersonaId, unit: UnitId, cursor: string | undefined): boolean => {
    const probeTasks = (read: () => readonly TaskRow[]): boolean => {
      const rows = readProbeTasks(personaId, read);
      return rows !== null && rows.length > 0;
    };

    switch (unit) {
      case 'U1':
        return probeTasks(() =>
          repos.tasks.listPageByPersonaState({
            personaId,
            state: 'running',
            limit: 1,
            ...(cursor === undefined ? {} : { afterId: cursor as TaskId }),
          }),
        );
      case 'U2':
        return probeTasks(() =>
          repos.tasks.listPageByPersonaState({
            personaId,
            state: 'queued',
            limit: 1,
            attemptFilter: { kind: 'invalid' },
            ...(cursor === undefined ? {} : { afterId: cursor as TaskId }),
          }),
        );
      case 'U3':
        return probeTasks(() =>
          repos.tasks.listPageByPersonaState({
            personaId,
            state: 'queued',
            limit: 1,
            attemptFilter: { kind: 'atLeast', value: cfg.policy.maxAttempts },
            ...(cursor === undefined ? {} : { afterId: cursor as TaskId }),
          }),
        );
      case 'U4':
        return probeTasks(() =>
          repos.tasks.listPageByPersonaState({
            personaId,
            state: 'paused',
            limit: 1,
            attemptFilter: { kind: 'invalid' },
            ...(cursor === undefined ? {} : { afterId: cursor as TaskId }),
          }),
        );
      case 'U4b':
        return probeTasks(() =>
          repos.tasks.listPageByPersonaState({
            personaId,
            state: 'paused',
            limit: 1,
            attemptFilter: { kind: 'atLeast', value: cfg.policy.maxAttempts },
            ...(cursor === undefined ? {} : { afterId: cursor as TaskId }),
          }),
        );
      case 'U5r':
      case 'U5a':
        return (
          repos.events.listPageByPersonaStatus({
            personaId,
            status: unit === 'U5r' ? 'received' : 'accepted',
            limit: 1,
            ...(cursor === undefined ? {} : { afterId: cursor as EventId }),
          }).length > 0
        );
      case 'U6n':
      case 'U6u':
      case 'U6c':
        return (
          repos.events.listPageByPersonaStatus({
            personaId,
            status:
              unit === 'U6n' ? 'noticed' : unit === 'U6u' ? 'understood' : 'response_committed',
            limit: 1,
          }).length > 0
        );
      default:
        return false;
    }
  };

  const probeAll = (): void => {
    if (!personaEnumerationDone) {
      if (!takeProbe()) {
        return;
      }
      const rest = repos.personas.listPage({
        limit: 1,
        ...(personaCursor === undefined ? {} : { afterId: personaCursor }),
      });
      if (rest.length > 0) {
        abort(failure);
        return;
      }
    }

    for (const personaId of personas) {
      for (const unit of UNIT_ORDER) {
        const entry = progress.get(key(personaId, unit));
        if (entry?.done === true) {
          continue;
        }
        if (!takeProbe()) {
          return;
        }
        if (probeUnit(personaId, unit, entry?.cursor)) {
          abort(failure);
          return;
        }
        // A probe read error already replaced `stop`; stop probing right away so
        // the fail-closed reason cannot be lost after a later empty probe.
        if (pendingStop()?.reason === 'invalid_task_row') {
          return;
        }
        // Boundary log: one entry per completed probe. Diagnostics only; it
        // carries ids/unit names, never payload or free text.
        safeLog(cfg.logger, 'debug', 'recovery_probe', {
          personaId,
          unit,
          probes: state.probeQueries,
        });
      }
    }

    // Every remaining range was probed empty. A cancellation observed after the
    // final probe still wins: an aborted run must never report complete.
    if (aborted()) {
      stop = { reason: 'aborted' };
      return;
    }
    stop = null;
  };

  probeAll();

  const afterProbe = pendingStop();

  if (afterProbe === null) {
    safeLog(cfg.logger, 'info', 'recovery_completed', {
      personas: state.personas,
      requeued: totals.requeued,
      failed: totals.failed,
      expired: totals.expired,
      probed: state.probeQueries,
    });
    return report(null);
  }

  safeLog(cfg.logger, 'warn', 'recovery_incomplete', {
    reason: afterProbe.reason,
    ...(afterProbe.detail?.personaId === undefined
      ? {}
      : { personaId: afterProbe.detail.personaId }),
    ...(afterProbe.detail?.taskId === undefined ? {} : { taskId: afterProbe.detail.taskId }),
    ...(afterProbe.detail?.eventId === undefined ? {} : { eventId: afterProbe.detail.eventId }),
    scanned: state.personas,
  });
  return report(afterProbe);
}
