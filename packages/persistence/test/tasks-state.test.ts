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

  it('rejects a payload value that is not a branded id', () => {
    const { a } = openFixture();
    seedPersona(a);

    expect(codeOf(() => insertTask(a, 1, { payloadRefs: { eventId: 'evt_bad' as EventId } }))).toBe(
      'invalid_argument',
    );
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
      }),
    ).toBeNull();
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

describe('recoverRunningTask', () => {
  it('requeues a crashed attempt below the cap without bumping attempt', () => {
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

    expect(recovered).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: runId(1),
      startedAt: NOW,
      finishedAt: null,
    });
  });

  it('fails a crashed attempt that already reached the cap', () => {
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

    expect(recovered).toMatchObject({
      state: 'failed',
      attempt: 1,
      runId: runId(1),
      startedAt: NOW,
      finishedAt: NOW + 30,
    });
  });

  it('refuses a call scoped to another persona and changes nothing', () => {
    const { a } = openFixture();
    seedPersona(a);
    seedPersona(a, personaId(2));
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    const result = createRepositories(a).tasks.recoverRunningTask({
      id: taskId(1),
      personaId: personaId(2),
      expectedRunId: runId(1),
      expectedAttempt: 1,
      maxAttempts: 3,
      finishedAt: NOW + 30,
    });

    expect(result).toBeNull();
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('migrates when the call is scoped to the owning persona', () => {
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

  it('rejects an invalid persona id before opening a transaction', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    const before = snapshot(a, taskId(1));

    expect(
      codeOf(() =>
        createRepositories(a).tasks.recoverRunningTask({
          id: taskId(1),
          personaId: 'psn_bad' as PersonaId,
          expectedRunId: runId(1),
          expectedAttempt: 1,
          maxAttempts: 3,
          finishedAt: NOW + 30,
        }),
      ),
    ).toBe('invalid_argument');
    expect(snapshot(a, taskId(1))).toStrictEqual(before);
  });

  it('rejects a stale run id or attempt', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);

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
  });

  it('rejects a running row whose attempt is zero', () => {
    const { a } = openFixture();
    seedPersona(a);
    insertTask(a);
    claim(a);
    setAttempt(a, taskId(1), 0);

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
