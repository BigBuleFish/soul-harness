/**
 * P1 runtime recovery against a real migrated SQLite file.
 *
 * Seed rows through the persistence repositories (plus a few deliberate
 * row-level violations via `withWrite`, which the runtime itself never does),
 * then drive `recoverRuntime` and assert observable database state.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AdapterId,
  EventId,
  PersonaId,
  RunId,
  SourceId,
  TaskId,
} from '@soul-harness/contracts';
import {
  createRepositories,
  migrate,
  openStore,
  withWrite,
  type Store,
} from '@soul-harness/persistence';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RuntimeError,
  computeDefaultMaxScanQueries,
  isRuntimeError,
  recoverRuntime,
  type RecoveryReport,
  type RuntimeLogger,
} from '../src/index.js';

const NOW = 1_731_700_000_000;

function body(n: number): string {
  return `${'0'.repeat(24)}${String(n).padStart(2, '0')}`;
}

const pid = (n: number): PersonaId => `psn_${body(n)}` as PersonaId;
const tid = (n: number): TaskId => `tsk_${body(n)}` as TaskId;
const eid = (n: number): EventId => `evt_${body(n)}` as EventId;
const rid = (n: number): RunId => `run_${body(n)}` as RunId;

const POLICY = { maxAttempts: 3, retryBackoffMs: 0 } as const;
const ADAPTER = 'qq' as AdapterId;
const SOURCE = 'qq' as SourceId;

const silentLogger: RuntimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Fixture {
  readonly dir: string;
  readonly store: Store;
}

const fixtures: Fixture[] = [];

function openFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sh-recovery-'));
  const store = openStore({ file: join(dir, 'soul.db') });
  migrate(store);
  const fixture = { dir, store };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    try {
      fixture.store.close();
    } catch {
      // Already closed by a test that exercises shutdown paths.
    }
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function repos(store: Store) {
  return createRepositories(store);
}

function seedPersona(store: Store, n = 1, state: 'RUNNING' | 'SUSPENDED' = 'RUNNING'): void {
  repos(store).personas.insert({
    id: pid(n),
    displayName: `P${n}`,
    state,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedTask(store: Store, n = 1, persona = 1): void {
  repos(store).tasks.insertQueuedTask({
    id: tid(n),
    personaId: pid(persona),
    kind: 'thought.run',
    channel: 'inner',
  });
}

function seedEvent(
  store: Store,
  n: number,
  persona: number,
  status: 'received' | 'accepted' | 'noticed' | 'understood' | 'response_committed',
  ref = `ref-${n}`,
): void {
  repos(store).events.insert({
    id: eid(n),
    personaId: pid(persona),
    source: SOURCE,
    adapterId: ADAPTER,
    adapterEventRef: ref,
    status,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

/** Test-only row surgery: the runtime itself never writes SQL. */
function mutate(store: Store, sql: string, ...params: readonly (string | number | null)[]): void {
  withWrite(store, (tx) => {
    tx.prepare(sql).run(...params);
  });
}

function claimRunning(store: Store, n = 1, persona = 1): void {
  repos(store).tasks.claimNext({
    personaId: pid(persona),
    channel: 'inner',
    now: NOW,
    runId: rid(n),
    maxAttempts: 3,
    kinds: ['thought.run'],
  });
}

function taskState(store: Store, n = 1) {
  return repos(store).tasks.getById(tid(n));
}

function eventState(store: Store, n = 1) {
  return repos(store).events.getById(eid(n));
}

async function recover(
  store: Store,
  overrides: Partial<Parameters<typeof recoverRuntime>[0]> = {},
): Promise<RecoveryReport> {
  return recoverRuntime({
    store,
    logger: silentLogger,
    policy: POLICY,
    now: () => NOW,
    ...overrides,
  });
}

function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => 'no-throw',
    (error: unknown) => (isRuntimeError(error) ? error.code : 'not-a-runtime-error'),
  );
}

describe('recoverRuntime — parameter validation', () => {
  it('applies defaults and reports an empty database as complete', async () => {
    const { store } = openFixture();

    const report = await recover(store);

    expect(report).toStrictEqual({
      personasScanned: 0,
      tasks: { requeued: 0, failed: 0 },
      events: { expired: 0 },
      incomplete: null,
    });
  });

  it('rejects an out-of-range batchSize', async () => {
    const { store } = openFixture();

    for (const bad of [0, 501, 1.5, 'x', null]) {
      expect(await codeOfAsync(() => recover(store, { batchSize: bad as never }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('rejects out-of-range maxRowsPerRun', async () => {
    const { store } = openFixture();

    for (const bad of [0, 1_000_001, 2.5, -1]) {
      expect(await codeOfAsync(() => recover(store, { maxRowsPerRun: bad as never }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('rejects out-of-range maxPersonasPerRun', async () => {
    const { store } = openFixture();

    for (const bad of [0, 10_001, 1.2]) {
      expect(await codeOfAsync(() => recover(store, { maxPersonasPerRun: bad as never }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('rejects out-of-range maxProbeQueries', async () => {
    const { store } = openFixture();

    for (const bad of [0, 10_001, 3.3]) {
      expect(await codeOfAsync(() => recover(store, { maxProbeQueries: bad as never }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('rejects explicit maxScanQueries outside [1, 1000000]', async () => {
    const { store } = openFixture();

    for (const bad of [0, 1_000_001, 1.5]) {
      expect(await codeOfAsync(() => recover(store, { maxScanQueries: bad as never }))).toBe(
        'invalid_argument',
      );
    }
    await expect(recover(store, { maxScanQueries: 1 })).resolves.toBeDefined();
    await expect(recover(store, { maxScanQueries: 1_000_000 })).resolves.toBeDefined();
  });

  it('rejects an invalid policy', async () => {
    const { store } = openFixture();

    for (const policy of [
      { maxAttempts: 0, retryBackoffMs: 0 },
      { maxAttempts: 101, retryBackoffMs: 0 },
      { maxAttempts: 3, retryBackoffMs: -1 },
      { maxAttempts: 3, retryBackoffMs: 86_400_001 },
      {},
    ]) {
      expect(await codeOfAsync(() => recover(store, { policy: policy as never }))).toBe(
        'invalid_argument',
      );
    }
  });

  it('rejects a missing store, logger or policy', async () => {
    const { store } = openFixture();

    expect(
      await codeOfAsync(() => recoverRuntime({ logger: silentLogger, policy: POLICY } as never)),
    ).toBe('invalid_argument');
    expect(await codeOfAsync(() => recoverRuntime({ store, policy: POLICY } as never))).toBe(
      'invalid_argument',
    );
    expect(await codeOfAsync(() => recoverRuntime({ store, logger: silentLogger } as never))).toBe(
      'invalid_argument',
    );
  });

  it('rejects a non-function clock', async () => {
    const { store } = openFixture();

    expect(await codeOfAsync(() => recover(store, { now: 42 as never }))).toBe('invalid_argument');
  });

  it('rejects a non-AbortSignal signal', async () => {
    const { store } = openFixture();

    expect(await codeOfAsync(() => recover(store, { signal: {} as never }))).toBe(
      'invalid_argument',
    );
  });

  it('computes the documented automatic scan-query budget', () => {
    expect(
      computeDefaultMaxScanQueries({
        batchSize: 200,
        maxPersonasPerRun: 200,
        maxRowsPerRun: 10_000,
      }),
    ).toBe(12_002);
    expect(
      computeDefaultMaxScanQueries({
        batchSize: 200,
        maxPersonasPerRun: 400,
        maxRowsPerRun: 10_000,
      }),
    ).toBe(14_003);
    expect(
      computeDefaultMaxScanQueries({
        batchSize: 1,
        maxPersonasPerRun: 10_000,
        maxRowsPerRun: 1_000_000,
      }),
    ).toBe(1_110_001);
  });

  it('accepts the extreme automatic budget without clamping it', async () => {
    const { store } = openFixture();

    const report = await recover(store, {
      batchSize: 1,
      maxPersonasPerRun: 10_000,
      maxRowsPerRun: 1_000_000,
    });

    expect(report.incomplete).toBeNull();
  });
});

describe('recoverRuntime — scan and budget behavior', () => {
  it('recovers a mixed database in one complete pass', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    seedEvent(store, 1, 1, 'accepted');

    const report = await recover(store);

    expect(report.incomplete).toBeNull();
    expect(report.personasScanned).toBe(1);
    expect(report.tasks).toStrictEqual({ requeued: 1, failed: 0 });
    expect(report.events).toStrictEqual({ expired: 1 });
    expect(taskState(store, 1)).toMatchObject({ state: 'queued', attempt: 1 });
    expect(eventState(store, 1)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
  });

  it('stops at maxRowsPerRun without over-reading', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    for (let n = 1; n <= 20; n += 1) {
      seedTask(store, n);
      claimRunning(store, n);
    }

    const report = await recover(store, { batchSize: 8, maxRowsPerRun: 10 });

    expect(report.incomplete?.reason).toBe('row_budget_exceeded');
    // The row budget counts every scanned row, including the persona page, so at
    // most ten tasks can have been read — and no row may be read beyond it.
    expect(report.tasks.requeued + report.tasks.failed).toBeLessThanOrEqual(10);
    const remainingRunning = repos(store).tasks.listByPersonaState({
      personaId: pid(1),
      state: 'running',
    });
    expect(remainingRunning.length).toBeGreaterThanOrEqual(10);
  });

  it('reports scan_query_budget_exceeded when the query budget stops the scan', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);

    const report = await recover(store, { maxScanQueries: 1 });

    expect(report.incomplete?.reason).toBe('scan_query_budget_exceeded');
    expect(taskState(store, 1)?.state).toBe('running');
  });

  it('reports persona_budget_exceeded and probes the remaining personas', async () => {
    const { store } = openFixture();
    for (let n = 1; n <= 3; n += 1) {
      seedPersona(store, n);
    }
    seedTask(store, 1, 3);
    claimRunning(store, 1, 3);

    const report = await recover(store, { maxPersonasPerRun: 2 });

    expect(report.incomplete?.reason).toBe('persona_budget_exceeded');
    expect(report.personasScanned).toBe(2);
  });

  it('reports probe_budget_exceeded when the probe cannot finish', async () => {
    const { store } = openFixture();
    // No tasks: the first probe (U1) is empty, the next probe hits the budget.
    seedPersona(store, 1);

    const report = await recover(store, { maxScanQueries: 1, maxProbeQueries: 1 });

    expect(report.incomplete?.reason).toBe('probe_budget_exceeded');
  });

  it('reports complete when a budget stop is followed by empty probes', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);

    const report = await recover(store, { maxScanQueries: 1 });

    expect(report.incomplete).toBeNull();
    expect(report.personasScanned).toBe(1);
  });

  it('reports complete for an empty database even with a tiny query budget', async () => {
    const { store } = openFixture();

    const report = await recover(store, { maxScanQueries: 1 });

    expect(report.incomplete).toBeNull();
  });

  it('aborts before scanning when the signal is already aborted', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    const controller = new AbortController();
    controller.abort();

    const report = await recover(store, { signal: controller.signal });

    expect(report.incomplete?.reason).toBe('aborted');
    expect(taskState(store, 1)?.state).toBe('queued');
  });

  it('aborts mid-run when the signal trips after start', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    const controller = new AbortController();
    const abortingLogger: RuntimeLogger = {
      ...silentLogger,
      info: (event) => {
        if (event === 'recovery_started') {
          controller.abort();
        }
      },
    };

    const report = await recover(store, { signal: controller.signal, logger: abortingLogger });

    expect(report.incomplete?.reason).toBe('aborted');
  });

  it('never claims tasks (recovery only requeues)', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);

    await recover(store);

    expect(taskState(store, 1)).toMatchObject({ state: 'queued', attempt: 0, runId: null });
  });
});

describe('recoverRuntime — task state handling', () => {
  it('U1: attempt below the cap is requeued without bumping attempt', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);

    const report = await recover(store);

    expect(report.tasks).toStrictEqual({ requeued: 1, failed: 0 });
    expect(taskState(store, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: rid(1) });
  });

  it('U1: attempt at the cap becomes failed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 3 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.tasks).toStrictEqual({ requeued: 0, failed: 1 });
    expect(taskState(store, 1)).toMatchObject({ state: 'failed', attempt: 3 });
  });

  it('U1: attempt above the cap also becomes failed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 9 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.tasks.failed).toBe(1);
    expect(taskState(store, 1)?.state).toBe('failed');
  });

  it('U1: a changed run_id is a concurrent modification, not a success', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(store, 'UPDATE tasks SET run_id = ? WHERE id = ?', rid(9), tid(1));
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
    expect(taskState(store, 1)?.state).toBe('running');
  });

  it('U1: a changed attempt is a concurrent modification', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(store, 'UPDATE tasks SET attempt = 2 WHERE id = ?', tid(1));
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
    expect(taskState(store, 1)?.state).toBe('running');
  });

  it('U1: a task that leaves running is a concurrent modification', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(store, "UPDATE tasks SET state = 'failed' WHERE id = ?", tid(1));
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
    expect(taskState(store, 1)?.state).toBe('failed');
  });

  it('U1: a task moved to another persona is a concurrent modification', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedPersona(store, 2);
    seedTask(store, 1);
    claimRunning(store, 1);
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(store, 'UPDATE tasks SET persona_id = ? WHERE id = ?', pid(2), tid(1));
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
  });

  it('U1: an invalid run_id fails closed without writing', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET run_id = NULL WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
    expect(report.incomplete?.detail?.taskId).toBe(tid(1));
    expect(taskState(store, 1)).toMatchObject({ state: 'running', runId: null });
  });

  it('U1: attempt 0 fails closed without writing', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 0 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
    expect(taskState(store, 1)).toMatchObject({ state: 'running', attempt: 0 });
  });

  it('U1: a non-integer attempt fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 1.5 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
  });

  it('U1: a null started_at fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET started_at = NULL WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
  });

  it('U1: a non-null finished_at fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    mutate(store, 'UPDATE tasks SET finished_at = ? WHERE id = ?', NOW + 1, tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
  });

  it('U2: a queued row with a fractional attempt fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 1.5 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
    expect(taskState(store, 1)).toMatchObject({ state: 'queued', attempt: 1.5 });
  });

  it('U2: a queued row with a negative attempt fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = -1 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
  });

  it('U3: a queued row at the cap becomes failed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    seedTask(store, 2);
    mutate(store, 'UPDATE tasks SET attempt = 3 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.tasks.failed).toBe(1);
    expect(taskState(store, 1)?.state).toBe('failed');
    expect(taskState(store, 2)?.state).toBe('queued');
  });

  it('U3: a concurrent change is reported instead of overwritten', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    mutate(store, 'UPDATE tasks SET attempt = 3 WHERE id = ?', tid(1));
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(store, 'UPDATE tasks SET state = ? WHERE id = ?', 'done', tid(1));
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
    expect(taskState(store, 1)?.state).toBe('done');
  });

  it('U4: a paused row with an invalid attempt fails closed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    mutate(store, "UPDATE tasks SET state = 'paused', attempt = 1.5 WHERE id = ?", tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
  });

  it('U4b: a paused row at the cap becomes failed', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    mutate(store, "UPDATE tasks SET state = 'paused', attempt = 3 WHERE id = ?", tid(1));

    const report = await recover(store);

    expect(report.tasks.failed).toBe(1);
    expect(taskState(store, 1)).toMatchObject({ state: 'failed', finishedAt: NOW });
  });

  it('stops writing after a fail-closed abort', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    seedTask(store, 2);
    claimRunning(store, 1);
    claimRunning(store, 2);
    mutate(store, 'UPDATE tasks SET attempt = 0 WHERE id = ?', tid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('invalid_task_row');
    expect(taskState(store, 2)?.state).toBe('running');
  });
});

describe('recoverRuntime — event state handling', () => {
  it('U5: a received event becomes expired/buffer_lost', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'received');

    const report = await recover(store);

    expect(report.events.expired).toBe(1);
    expect(eventState(store, 1)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
  });

  it('U5: an accepted event becomes expired/buffer_lost', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'accepted');

    const report = await recover(store);

    expect(report.events.expired).toBe(1);
    expect(eventState(store, 1)?.statusReason).toBe('buffer_lost');
  });

  it('U5: a concurrent status change is reported, not overwritten', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'accepted');
    let calls = 0;
    const racingClock = (): number => {
      calls += 1;
      if (calls === 2) {
        mutate(
          store,
          "UPDATE events SET status = 'expired', status_reason = 'ttl_expired' WHERE id = ?",
          eid(1),
        );
      }
      return NOW;
    };

    const report = await recover(store, { now: racingClock });

    expect(report.incomplete?.reason).toBe('concurrent_modification');
    expect(eventState(store, 1)).toMatchObject({
      status: 'expired',
      statusReason: 'ttl_expired',
    });
  });

  it('U5: an archived row fails closed and is not rewritten', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'accepted');
    mutate(store, "UPDATE events SET archive_state = 'pending' WHERE id = ?", eid(1));

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('archive_state_present');
    expect(eventState(store, 1)).toMatchObject({ status: 'accepted', archiveState: 'pending' });
  });

  it('U6: a noticed event aborts recovery', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'noticed');

    const report = await recover(store);

    expect(report.incomplete?.reason).toBe('unexpected_event_status');
    expect(eventState(store, 1)?.status).toBe('noticed');
  });

  it('U6: an understood event aborts recovery', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'understood');

    expect((await recover(store)).incomplete?.reason).toBe('unexpected_event_status');
  });

  it('U6: a response_committed event aborts recovery', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'response_committed');

    expect((await recover(store)).incomplete?.reason).toBe('unexpected_event_status');
  });

  it('leaves terminal events untouched', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedEvent(store, 1, 1, 'accepted');
    seedEvent(store, 2, 1, 'accepted');
    mutate(
      store,
      "UPDATE events SET status = 'rejected', status_reason = 'auth_failed' WHERE id = ?",
      eid(1),
    );
    mutate(
      store,
      "UPDATE events SET status = 'expired', status_reason = 'ttl_expired' WHERE id = ?",
      eid(2),
    );

    const report = await recover(store);

    expect(report.incomplete).toBeNull();
    expect(eventState(store, 1)).toMatchObject({ status: 'rejected', statusReason: 'auth_failed' });
    expect(eventState(store, 2)).toMatchObject({ status: 'expired', statusReason: 'ttl_expired' });
  });

  it('does not touch events of a suspended persona beyond U5/U6 rules', async () => {
    const { store } = openFixture();
    seedPersona(store, 1, 'SUSPENDED');
    seedEvent(store, 1, 1, 'accepted');

    const report = await recover(store);

    expect(report.incomplete).toBeNull();
    expect(eventState(store, 1)?.status).toBe('expired');
  });
});

describe('recoverRuntime — structure and integration', () => {
  it('is idempotent across runs', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    seedEvent(store, 1, 1, 'accepted');

    const first = await recover(store);
    const second = await recover(store);

    expect(first.incomplete).toBeNull();
    expect(second).toStrictEqual({
      personasScanned: 1,
      tasks: { requeued: 0, failed: 0 },
      events: { expired: 0 },
      incomplete: null,
    });
  });

  it('logs start and completion without payload text', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    const events: string[] = [];
    const logger: RuntimeLogger = {
      debug: () => undefined,
      info: (event) => events.push(event),
      warn: (event) => events.push(event),
      error: () => undefined,
    };

    await recover(store, { logger });

    expect(events).toStrictEqual(['recovery_started', 'recovery_completed']);
  });

  it('survives a throwing logger', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    const logger: RuntimeLogger = {
      debug: () => {
        throw new Error('boom');
      },
      info: () => {
        throw new Error('boom');
      },
      warn: () => {
        throw new Error('boom');
      },
      error: () => {
        throw new Error('boom');
      },
    };

    await expect(recover(store, { logger })).resolves.toMatchObject({ incomplete: null });
  });

  it('rejects an invalid clock on a later read', async () => {
    const { store } = openFixture();
    seedPersona(store, 1);
    seedTask(store, 1);
    claimRunning(store, 1);
    let calls = 0;
    const badClock = (): number => {
      calls += 1;
      return calls === 1 ? NOW : -1;
    };

    expect(await codeOfAsync(() => recover(store, { now: badClock }))).toBe('invalid_clock');
  });

  it('does not contain SQL or direct database access in the recovery sources', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'recovery');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) {
        continue;
      }
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text).not.toMatch(/DatabaseSync|\.prepare\(/);
      expect(text).not.toMatch(/node:sqlite/);
    }
  });

  it('exposes runtime errors with stable codes', async () => {
    const { store } = openFixture();
    const error = await recover(store, { batchSize: 0 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe('invalid_argument');
  });
});
