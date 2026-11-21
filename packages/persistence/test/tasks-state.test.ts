/**
 * `tasks` repository — the D1 conditional state machine.
 *
 * Every test runs against a real migrated SQLite file. Nothing here calls a
 * generic state setter: the row can only move through the guarded methods, and
 * every "no match" case is verified by reading the row back, not by trusting the
 * returned value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { EventId, PersonaId, RunId, TaskId, ThreadId } from '@soul-harness/contracts';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import {
  createRepositories,
  createTaskRepository,
  migrate,
  openStore,
  type ClaimNextTaskInput,
  type FailTaskInput,
  type InsertQueuedTaskInput,
  type Store,
} from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;

/** 24 zeros + 2 digits = the 26 characters an id body needs; digits sort well. */
function body(n: number): string {
  return `${'0'.repeat(24)}${String(n).padStart(2, '0')}`;
}

const taskId = (n: number): TaskId => `tsk_${body(n)}` as TaskId;
const runId = (n: number): RunId => `run_${body(n)}` as RunId;
const personaId = (n: number): PersonaId => `psn_${body(n)}` as PersonaId;
const eventId = (n: number): EventId => `evt_${body(n)}` as EventId;
const threadId = (n: number): ThreadId => `thr_${body(n)}` as ThreadId;

interface Fixture {
  readonly dir: string;
  readonly a: Store;
  readonly b: Store | null;
}

const fixtures: Fixture[] = [];

function openFixture(dual = false): Fixture {
  const dir = makeTempDir('sh-tasks-');
  const a = openStore({ file: dbPathIn(dir) });
  migrate(a);
  const b = dual ? openStore({ file: dbPathIn(dir) }) : null;
  const fixture = { dir, a, b };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    fixture.b?.close();
    fixture.a.close();
    removeTempDir(fixture.dir);
  }
});

function seedPersona(
  store: Store,
  id: PersonaId = personaId(1),
  state: 'RUNNING' | 'SUSPENDED' | 'STOPPED' = 'RUNNING',
): void {
  createRepositories(store).personas.insert({
    id,
    displayName: 'Persona',
    state,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function insertTask(store: Store, n = 1, overrides: Partial<InsertQueuedTaskInput> = {}): void {
  createRepositories(store).tasks.insertQueuedTask({
    id: taskId(n),
    personaId: personaId(1),
    kind: 'thought.run',
    channel: 'inner',
    ...overrides,
  });
}

/** Injects a row whose `attempt` is not a valid integer (e.g. 1.5 or -1). */
function insertRawQueued(store: Store, id: TaskId, attempt: number, state = 'queued'): void {
  databaseOf(store)
    .prepare(
      `INSERT INTO tasks
       (id, persona_id, kind, channel, state, priority, payload_json, scheduled_at, attempt)
     VALUES (?, ?, 'thought.run', 'inner', ?, 0, NULL, NULL, ?)`,
    )
    .run(id, personaId(1), state, attempt);
}

function setAttempt(store: Store, id: TaskId, attempt: number): void {
  databaseOf(store).prepare('UPDATE tasks SET attempt = ? WHERE id = ?').run(attempt, id);
}

function setStateOnly(store: Store, id: TaskId, state: string): void {
  databaseOf(store).prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, id);
}

function claim(store: Store, overrides: Partial<ClaimNextTaskInput> = {}) {
  return createRepositories(store).tasks.claimNext({
    personaId: personaId(1),
    channel: 'inner',
    now: NOW,
    runId: runId(1),
    maxAttempts: 3,
    kinds: ['thought.run'],
    ...overrides,
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return error instanceof PersistenceError ? error.code : 'not-a-persistence-error';
  }
}

function snapshot(store: Store, id: TaskId) {
  const row = createRepositories(store).tasks.getById(id);
  return row === null ? null : { ...row };
}

describe('insertQueuedTask', () => {
  it('creates the only legal initial state', () => {
    const { a } = openFixture();
    seedPersona(a);

    insertTask(a);

    expect(snapshot(a, taskId(1))).toMatchObject({
      id: taskId(1),
      personaId: personaId(1),
      kind: 'thought.run',
      channel: 'inner',
      state: 'queued',
      priority: 0,
      runId: null,
      payloadJson: null,
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
      attempt: 0,
    });
  });

  it('stores only whitelisted payload references', () => {
    const { a } = openFixture();
    seedPersona(a);

    insertTask(a, 1, { payloadRefs: { eventId: eventId(1), threadId: threadId(1) } });

    expect(createRepositories(a).tasks.getById(taskId(1))?.payloadJson).toStrictEqual({
      eventId: eventId(1),
      threadId: threadId(1),
    });
  });

  it('rejects a payload key outside the whitelist', () => {
    const { a } = openFixture();
    seedPersona(a);
    const badRefs = { sessionId: 'ses_00000000000000000000000001' } as unknown as NonNullable<
      InsertQueuedTaskInput['payloadRefs']
    >;

    const code = codeOf(() => insertTask(a, 1, { payloadRefs: badRefs }));

    expect(code).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toBeNull();
  });

  it('rejects payload values that are not branded ids', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { payloadRefs: { eventId: 'evt_bad' as EventId } }))).toBe(
      'invalid_argument',
    );
    expect(codeOf(() => insertTask(a, 2, { payloadRefs: { threadId: 'x' as ThreadId } }))).toBe(
      'invalid_argument',
    );
    expect(snapshot(a, taskId(1))).toBeNull();
    expect(snapshot(a, taskId(2))).toBeNull();
  });

  it('rejects nodeId, which P1 does not support', () => {
    const { a } = openFixture();
    seedPersona(a);
    const refs = { nodeId: 'node-1' } as unknown as NonNullable<
      InsertQueuedTaskInput['payloadRefs']
    >;

    expect(codeOf(() => insertTask(a, 1, { payloadRefs: refs }))).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toBeNull();
  });

  it('rejects free text smuggled into payload references', () => {
    const { a } = openFixture();
    seedPersona(a);
    const refs = { text: 'hello world' } as unknown as NonNullable<
      InsertQueuedTaskInput['payloadRefs']
    >;

    expect(codeOf(() => insertTask(a, 1, { payloadRefs: refs }))).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toBeNull();
  });

  it('rejects an invalid kind', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { kind: 'Thought.Run' }))).toBe('invalid_argument');
  });

  it('rejects an invalid channel', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { channel: 'bogus' as never }))).toBe('invalid_argument');
  });

  it('rejects a priority outside the range', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { priority: 1001 }))).toBe('invalid_argument');
    expect(codeOf(() => insertTask(a, 2, { priority: 1.5 }))).toBe('invalid_argument');
  });

  it('rejects an unsafe scheduledAt', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { scheduledAt: -1 }))).toBe('invalid_argument');
    expect(codeOf(() => insertTask(a, 2, { scheduledAt: 1.5 }))).toBe('invalid_argument');
  });

  it('rejects an invalid task id', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { id: 'tsk_bad' as TaskId }))).toBe('invalid_argument');
  });

  it('rejects an invalid persona id', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { personaId: 'psn_bad' as PersonaId }))).toBe(
      'invalid_argument',
    );
  });
});

describe('claimNext', () => {
  it('claims a due task and starts the first attempt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);

    const claimed = claim(a);

    expect(claimed).toMatchObject({
      state: 'running',
      attempt: 1,
      runId: runId(1),
      startedAt: NOW,
      finishedAt: null,
    });
  });

  it('returns null when nothing is queued', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(claim(a)).toBeNull();
  });

  it('skips a task scheduled in the future and claims it when due', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { scheduledAt: NOW + 100 });

    expect(claim(a)).toBeNull();
    expect(claim(a, { now: NOW + 100, runId: runId(2) })?.id).toBe(taskId(1));
  });

  it('only claims tasks on the requested channel', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { channel: 'audit' });

    expect(claim(a)).toBeNull();
    expect(claim(a, { channel: 'audit' })?.id).toBe(taskId(1));
  });

  it('only claims kinds with a registered handler', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { kind: 'sleep.cycle' });

    expect(claim(a)).toBeNull();
    expect(claim(a, { kinds: ['sleep.cycle'] })?.id).toBe(taskId(1));
  });

  it('returns null for an empty kind list without touching the database', () => {
    const repo = createTaskRepository({} as unknown as Store);

    expect(
      repo.claimNext({
        personaId: personaId(1),
        channel: 'inner',
        now: NOW,
        runId: runId(1),
        maxAttempts: 3,
        kinds: [],
      }),
    ).toBeNull();
  });

  it('skips tasks whose persona is not RUNNING', () => {
    const { a } = openFixture();
    seedPersona(a, personaId(1), 'SUSPENDED');
    insertTask(a);

    expect(claim(a)).toBeNull();
    expect(snapshot(a, taskId(1))).toMatchObject({ state: 'queued', attempt: 0, runId: null });
  });

  it('skips tasks whose persona is STOPPED', () => {
    const { a } = openFixture();
    seedPersona(a, personaId(1), 'STOPPED');
    insertTask(a);
    const before = snapshot(a, taskId(1));

    expect(claim(a)).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('prefers the higher priority', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { priority: 1 });
    insertTask(a, 2, { priority: 5 });

    expect(claim(a)?.id).toBe(taskId(2));
  });

  it('orders equal priorities by schedule time, with NULL last', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { scheduledAt: NOW - 50 });
    insertTask(a, 2);

    expect(claim(a)?.id).toBe(taskId(1));
    expect(claim(a, { runId: runId(2) })?.id).toBe(taskId(2));
  });

  it('falls back to id order', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 2);
    insertTask(a, 1);

    expect(claim(a)?.id).toBe(taskId(1));
  });

  it('never claims a row whose attempt is not a valid integer', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertRawQueued(a, taskId(1), 1.5);
    insertRawQueued(a, taskId(2), -1);
    insertTask(a, 3);

    expect(claim(a)?.id).toBe(taskId(3));
    expect(claim(a, { runId: runId(2) })).toBeNull();
  });

  it('never claims a row whose attempt exceeds the safe integer range', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertRawQueued(a, taskId(1), 1e20);
    insertTask(a, 2);
    const before = snapshot(a, taskId(1));

    expect(claim(a)?.id).toBe(taskId(2));
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('lets exactly one of two connections claim the same task', () => {
    const fixture = openFixture(true);
    seedPersona(fixture.a);
    insertTask(fixture.a);

    const first = claim(fixture.a);
    const second = claim(fixture.b as Store, { runId: runId(2) });

    expect(first?.id).toBe(taskId(1));
    expect(second).toBeNull();
    expect(
      createRepositories(fixture.a).tasks.listByPersonaState({
        personaId: personaId(1),
        state: 'running',
      }),
    ).toHaveLength(1);
  });
});

describe('completeTask', () => {
  it('finishes the running attempt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    const done = createRepositories(a).tasks.completeTask({
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      finishedAt: NOW + 9,
    });

    expect(done).toMatchObject({ state: 'done', finishedAt: NOW + 9, attempt: 1 });
  });

  it('rejects a stale run id without changing the row', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    const result = createRepositories(a).tasks.completeTask({
      id: taskId(1),
      runId: runId(2),
      expectedAttempt: 1,
      finishedAt: NOW + 9,
    });

    expect(result).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('rejects a stale attempt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    expect(
      createRepositories(a).tasks.completeTask({
        id: taskId(1),
        runId: runId(1),
        expectedAttempt: 2,
        finishedAt: NOW + 9,
      }),
    ).toBeNull();
  });

  it('refuses to complete a task that is not running', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);

    expect(
      createRepositories(a).tasks.completeTask({
        id: taskId(1),
        runId: runId(1),
        expectedAttempt: 1,
        finishedAt: NOW + 9,
      }),
    ).toBeNull();
  });
});

describe('failTask', () => {
  it('requeues below the cap and keeps the failed run as history', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    const requeued = createRepositories(a).tasks.failTask({
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      retry: true,
      finishedAt: NOW + 5,
      nextScheduledAt: NOW + 20,
    });

    expect(requeued).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: runId(1),
      finishedAt: null,
      scheduledAt: NOW + 20,
    });
  });

  it('fails when the cap is reached even if retry is true', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    const failed = createRepositories(a).tasks.failTask({
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 1,
      retry: true,
      finishedAt: NOW + 5,
      nextScheduledAt: NOW + 20,
    });

    expect(failed).toMatchObject({ state: 'failed', finishedAt: NOW + 5 });
  });

  it('fails when retry is false', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    expect(
      createRepositories(a).tasks.failTask({
        id: taskId(1),
        runId: runId(1),
        expectedAttempt: 1,
        maxAttempts: 3,
        retry: false,
        finishedAt: NOW + 5,
        nextScheduledAt: null,
      }),
    ).toMatchObject({ state: 'failed' });
  });

  it('rejects a stale run id', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.failTask({
        id: taskId(1),
        runId: runId(2),
        expectedAttempt: 1,
        maxAttempts: 3,
        retry: true,
        finishedAt: NOW + 5,
        nextScheduledAt: NOW + 20,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('rejects a stale attempt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    expect(
      createRepositories(a).tasks.failTask({
        id: taskId(1),
        runId: runId(1),
        expectedAttempt: 2,
        maxAttempts: 3,
        retry: true,
        finishedAt: NOW + 5,
        nextScheduledAt: NOW + 20,
      }),
    ).toBeNull();
  });

  it('R2: accepts an explicit null schedule and leaves scheduled_at NULL', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { scheduledAt: NOW - 10 });
    claim(a);

    const requeued = createRepositories(a).tasks.failTask({
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      retry: true,
      finishedAt: NOW + 5,
      nextScheduledAt: null,
    });

    expect(requeued).toMatchObject({ state: 'queued', scheduledAt: null, finishedAt: null });
  });

  it('R2: rejects an omitted nextScheduledAt before the transaction', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));
    const omitted = {
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      retry: true,
      finishedAt: NOW + 5,
    } as unknown as FailTaskInput;

    expect(codeOf(() => createRepositories(a).tasks.failTask(omitted))).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R2: rejects an explicit undefined nextScheduledAt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));
    const withUndefined = {
      id: taskId(1),
      runId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      retry: true,
      finishedAt: NOW + 5,
      nextScheduledAt: undefined,
    } as unknown as FailTaskInput;

    expect(codeOf(() => createRepositories(a).tasks.failTask(withUndefined))).toBe(
      'invalid_argument',
    );
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R2: rejects an invalid nextScheduledAt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        codeOf(() =>
          createRepositories(a).tasks.failTask({
            id: taskId(1),
            runId: runId(1),
            expectedAttempt: 1,
            maxAttempts: 3,
            retry: true,
            finishedAt: NOW + 5,
            nextScheduledAt: bad,
          }),
        ),
      ).toBe('invalid_argument');
    }
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });
});

describe('failExhaustedTask', () => {
  it('fails a queued task whose attempt reached the cap', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    setAttempt(a, taskId(1), 3);

    expect(
      createRepositories(a).tasks.failExhaustedTask({
        id: taskId(1),
        expectedState: 'queued',
        expectedAttempt: 3,
        maxAttempts: 3,
        finishedAt: NOW + 7,
      }),
    ).toMatchObject({ state: 'failed', finishedAt: NOW + 7 });
  });

  it('fails a paused task whose attempt reached the cap', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    setStateOnly(a, taskId(1), 'paused');
    setAttempt(a, taskId(1), 4);

    expect(
      createRepositories(a).tasks.failExhaustedTask({
        id: taskId(1),
        expectedState: 'paused',
        expectedAttempt: 4,
        maxAttempts: 3,
        finishedAt: NOW + 7,
      }),
    ).toMatchObject({ state: 'failed' });
  });

  it('leaves a task below the cap untouched', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    setAttempt(a, taskId(1), 1);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.failExhaustedTask({
        id: taskId(1),
        expectedState: 'queued',
        expectedAttempt: 1,
        maxAttempts: 3,
        finishedAt: NOW + 7,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });
});

describe('recoverRunningTask (R3 matrix)', () => {
  it('R3-1: attempt < max requeues with attempt/run/started unchanged and finished NULL', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    const recovered = createRepositories(a).tasks.recoverRunningTask({
      id: taskId(1),
      personaId: personaId(1),
      expectedRunId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      finishedAt: NOW + 30,
    });

    expect(recovered).toStrictEqual({
      id: taskId(1),
      personaId: personaId(1),
      kind: 'thought.run',
      channel: 'inner',
      state: 'queued',
      priority: 0,
      runId: runId(1),
      payloadJson: null,
      scheduledAt: null,
      startedAt: NOW,
      finishedAt: null,
      attempt: 1,
    });
  });

  it('R3-2: attempt >= max fails with finishedAt and keeps the other run fields', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    const recovered = createRepositories(a).tasks.recoverRunningTask({
      id: taskId(1),
      personaId: personaId(1),
      expectedRunId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 1,
      finishedAt: NOW + 30,
    });

    expect(recovered).toStrictEqual({
      id: taskId(1),
      personaId: personaId(1),
      kind: 'thought.run',
      channel: 'inner',
      state: 'failed',
      priority: 0,
      runId: runId(1),
      payloadJson: null,
      scheduledAt: null,
      startedAt: NOW,
      finishedAt: NOW + 30,
      attempt: 1,
    });
  });

  it('R3-3: a changed run_id makes the CAS miss and leaves the row untouched', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.recoverRunningTask({
        id: taskId(1),
        personaId: personaId(1),
        expectedRunId: runId(2),
        expectedAttempt: 1,
        maxAttempts: 3,
        finishedAt: NOW + 30,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R3-4: a changed attempt makes the CAS miss and leaves the row untouched', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.recoverRunningTask({
        id: taskId(1),
        personaId: personaId(1),
        expectedRunId: runId(1),
        expectedAttempt: 2,
        maxAttempts: 3,
        finishedAt: NOW + 30,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R3-5: a row that is no longer running makes the CAS miss and stays untouched', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    setStateOnly(a, taskId(1), 'failed');
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.recoverRunningTask({
        id: taskId(1),
        personaId: personaId(1),
        expectedRunId: runId(1),
        expectedAttempt: 1,
        maxAttempts: 3,
        finishedAt: NOW + 30,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
    expect(before?.state).toBe('failed');
  });

  it('R3-6: invalid attempt values never match the SQL guard and stay untouched', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    for (const bad of [0, 1.5, -1]) {
      setAttempt(a, taskId(1), bad);
      const before = snapshot(a, taskId(1));

      expect(
        createRepositories(a).tasks.recoverRunningTask({
          id: taskId(1),
          personaId: personaId(1),
          expectedRunId: runId(1),
          expectedAttempt: 1,
          maxAttempts: 3,
          finishedAt: NOW + 30,
        }),
      ).toBeNull();
      expect(snapshot(a, taskId(1))).toStrictEqual(before);
      expect(before?.state).toBe('running');
    }
  });

  it('R3-7: both success paths keep attempt/run_id/started_at and only change state/finished_at', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1);
    insertTask(a, 2);
    claim(a);
    claim(a, { runId: runId(2) });
    const beforeOne = snapshot(a, taskId(1));
    const beforeTwo = snapshot(a, taskId(2));

    const requeued = createRepositories(a).tasks.recoverRunningTask({
      id: taskId(1),
      personaId: personaId(1),
      expectedRunId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      finishedAt: NOW + 40,
    });
    const failed = createRepositories(a).tasks.recoverRunningTask({
      id: taskId(2),
      personaId: personaId(1),
      expectedRunId: runId(2),
      expectedAttempt: 1,
      maxAttempts: 1,
      finishedAt: NOW + 41,
    });

    expect(requeued).not.toBeNull();
    expect(failed).not.toBeNull();
    // Requeued: untouched run identity, finished_at cleared.
    expect(requeued?.attempt).toBe(beforeOne?.attempt);
    expect(requeued?.runId).toBe(beforeOne?.runId);
    expect(requeued?.startedAt).toBe(beforeOne?.startedAt);
    expect(requeued?.state).toBe('queued');
    expect(requeued?.finishedAt).toBeNull();
    // Failed: same run identity, finished_at written.
    expect(failed?.attempt).toBe(beforeTwo?.attempt);
    expect(failed?.runId).toBe(beforeTwo?.runId);
    expect(failed?.startedAt).toBe(beforeTwo?.startedAt);
    expect(failed?.state).toBe('failed');
    expect(failed?.finishedAt).toBe(NOW + 41);
  });

  it('R3-8: a row owned by A called with persona B is rejected with an identical row', () => {
    const { a } = openFixture();
    seedPersona(a);
    seedPersona(a, personaId(2));
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.recoverRunningTask({
        id: taskId(1),
        personaId: personaId(2),
        expectedRunId: runId(1),
        expectedAttempt: 1,
        maxAttempts: 3,
        finishedAt: NOW + 30,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R3-9: the owning persona is accepted and the task is requeued', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    expect(
      createRepositories(a).tasks.recoverRunningTask({
        id: taskId(1),
        personaId: personaId(1),
        expectedRunId: runId(1),
        expectedAttempt: 1,
        maxAttempts: 3,
        finishedAt: NOW + 30,
      })?.state,
    ).toBe('queued');
  });

  it('R3-10: empty, malformed and non-string persona ids are rejected before the transaction', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    for (const bad of ['', 'psn_bad', 42]) {
      expect(
        codeOf(() =>
          createRepositories(a).tasks.recoverRunningTask({
            id: taskId(1),
            personaId: bad as unknown as PersonaId,
            expectedRunId: runId(1),
            expectedAttempt: 1,
            maxAttempts: 3,
            finishedAt: NOW + 30,
          }),
        ),
      ).toBe('invalid_argument');
    }
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });
});

describe('setTaskState', () => {
  it('pauses a queued task and resumes it while below the cap', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    const tasks = createRepositories(a).tasks;

    expect(
      tasks.setTaskState({
        id: taskId(1),
        expectedState: 'queued',
        nextState: 'paused',
        at: NOW + 1,
      })?.state,
    ).toBe('paused');

    expect(
      tasks.setTaskState({
        id: taskId(1),
        expectedState: 'paused',
        nextState: 'queued',
        at: NOW + 2,
        maxAttempts: 3,
      })?.state,
    ).toBe('queued');
    expect(tasks.getById(taskId(1))?.finishedAt).toBeNull();
  });

  it('refuses to resume a task at the cap', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    setStateOnly(a, taskId(1), 'paused');
    setAttempt(a, taskId(1), 3);
    const before = snapshot(a, taskId(1));

    expect(
      createRepositories(a).tasks.setTaskState({
        id: taskId(1),
        expectedState: 'paused',
        nextState: 'queued',
        at: NOW + 2,
        maxAttempts: 3,
      }),
    ).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('cancels queued and paused tasks with a finish time', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1);
    insertTask(a, 2);
    setStateOnly(a, taskId(2), 'paused');
    const tasks = createRepositories(a).tasks;

    expect(
      tasks.setTaskState({
        id: taskId(1),
        expectedState: 'queued',
        nextState: 'cancelled',
        at: NOW + 3,
      }),
    ).toMatchObject({ state: 'cancelled', finishedAt: NOW + 3 });

    expect(
      tasks.setTaskState({
        id: taskId(2),
        expectedState: 'paused',
        nextState: 'cancelled',
        at: NOW + 4,
      }),
    ).toMatchObject({ state: 'cancelled', finishedAt: NOW + 4 });
  });

  it('rejects a running task and any other transition pair', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

    expect(
      codeOf(() =>
        createRepositories(a).tasks.setTaskState({
          id: taskId(1),
          expectedState: 'queued',
          nextState: 'cancelled',
          at: NOW + 3,
        }),
      ),
    ).toBe('no-throw');
    expect(snapshot(a, taskId(1))?.state).toBe('running');

    expect(
      codeOf(() =>
        createRepositories(a).tasks.setTaskState({
          id: taskId(1),
          expectedState: 'paused',
          nextState: 'paused',
          at: NOW + 3,
        }),
      ),
    ).toBe('invalid_argument');
  });
});

describe('listPageByPersonaState', () => {
  it('pages by primary key without skipping or repeating', () => {
    const { a } = openFixture();
    seedPersona(a);
    for (let n = 1; n <= 5; n += 1) {
      insertTask(a, n);
    }
    const tasks = createRepositories(a).tasks;

    const first = tasks.listPageByPersonaState({
      personaId: personaId(1),
      state: 'queued',
      limit: 2,
    });
    const second = tasks.listPageByPersonaState({
      personaId: personaId(1),
      state: 'queued',
      afterId: first[first.length - 1]!.id,
      limit: 2,
    });
    const third = tasks.listPageByPersonaState({
      personaId: personaId(1),
      state: 'queued',
      afterId: second[second.length - 1]!.id,
      limit: 2,
    });

    const seen = [...first, ...second, ...third].map((row) => row.id);
    expect(seen).toStrictEqual([1, 2, 3, 4, 5].map(taskId));
  });

  it('atLeast only matches valid attempts', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertRawQueued(a, taskId(1), 1);
    insertRawQueued(a, taskId(2), 3.5);
    insertRawQueued(a, taskId(3), 3);
    insertRawQueued(a, taskId(4), -1);

    const rows = createRepositories(a).tasks.listPageByPersonaState({
      personaId: personaId(1),
      state: 'queued',
      attemptFilter: { kind: 'atLeast', value: 2 },
    });

    expect(rows.map((row) => row.id)).toStrictEqual([taskId(3)]);
  });

  it('invalid matches exactly the non-claimable attempts', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertRawQueued(a, taskId(1), 1);
    insertRawQueued(a, taskId(2), 3.5);
    insertRawQueued(a, taskId(3), -1);

    const rows = createRepositories(a).tasks.listPageByPersonaState({
      personaId: personaId(1),
      state: 'queued',
      attemptFilter: { kind: 'invalid' },
    });

    expect(rows.map((row) => row.id)).toStrictEqual([taskId(2), taskId(3)]);
  });

  it('rejects an invalid cursor', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(
      codeOf(() =>
        createRepositories(a).tasks.listPageByPersonaState({
          personaId: personaId(1),
          state: 'queued',
          afterId: 'tsk_bad' as TaskId,
        }),
      ),
    ).toBe('invalid_argument');
  });

  it('R1: rejects atLeast with an extra key', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    const before = snapshot(a, taskId(1));

    expect(
      codeOf(() =>
        createRepositories(a).tasks.listPageByPersonaState({
          personaId: personaId(1),
          state: 'queued',
          attemptFilter: { kind: 'atLeast', value: 1, extra: true } as never,
        }),
      ),
    ).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('R1: rejects invalid with an extra key', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);

    expect(
      codeOf(() =>
        createRepositories(a).tasks.listPageByPersonaState({
          personaId: personaId(1),
          state: 'queued',
          attemptFilter: { kind: 'invalid', value: 1 } as never,
        }),
      ),
    ).toBe('invalid_argument');
  });

  it('R1: rejects null, arrays and non-objects before any database access', () => {
    // A bare store would throw a TypeError if validation let a query through.
    const repo = createTaskRepository({} as unknown as Store);

    for (const bad of [null, [], 'atLeast', 42]) {
      expect(
        codeOf(() =>
          repo.listPageByPersonaState({
            personaId: personaId(1),
            state: 'queued',
            attemptFilter: bad as never,
          }),
        ),
      ).toBe('invalid_argument');
    }
  });

  it('R1: rejects an attemptFilter.value that is not a non-negative safe integer', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    const before = snapshot(a, taskId(1));

    for (const bad of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        codeOf(() =>
          createRepositories(a).tasks.listPageByPersonaState({
            personaId: personaId(1),
            state: 'queued',
            attemptFilter: { kind: 'atLeast', value: bad } as never,
          }),
        ),
      ).toBe('invalid_argument');
    }
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });
});

describe('nextDueAt', () => {
  it('returns the earliest future schedule', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { scheduledAt: NOW + 100 });
    insertTask(a, 2, { scheduledAt: NOW + 50 });
    insertTask(a, 3);

    expect(createRepositories(a).tasks.nextDueAt({ after: NOW })).toBe(NOW + 50);
    expect(createRepositories(a).tasks.nextDueAt({ after: NOW + 60 })).toBe(NOW + 100);
  });

  it('ignores past schedules and returns null when nothing is ahead', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a, 1, { scheduledAt: NOW - 10 });

    expect(createRepositories(a).tasks.nextDueAt({ after: NOW })).toBeNull();
  });
});
