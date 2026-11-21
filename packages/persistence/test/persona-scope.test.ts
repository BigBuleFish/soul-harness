/**
 * Persona scope for every by-id repository operation (IDENTITY-PROTOCOL §1.5):
 * an id is an identity, not a credential. A caller that presents persona A must
 * never read or mutate B's rows, and the constraint lives in SQL — the tests
 * below keep every other guard (state, run_id, attempt) satisfied so only the
 * `persona_id` term can explain the miss.
 */

import type {
  AdapterId,
  EventId,
  PersonaId,
  RunId,
  SessionId,
  SourceId,
  TaskId,
} from '@soul-harness/contracts';
import {
  createRepositories,
  isPersistenceError,
  migrate,
  openStore,
  withWrite,
  type Store,
} from '../src/index.js';
import { afterEach, describe, expect, it } from 'vitest';

import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;
const BODY = '000000000000000000000000';
const A = `psn_${BODY}01` as PersonaId;
const B = `psn_${BODY}02` as PersonaId;
const SESSION_A = `ses_${BODY}01` as SessionId;
const SESSION_B = `ses_${BODY}02` as SessionId;
const EVENT_A = `evt_${BODY}01` as EventId;
const EVENT_B = `evt_${BODY}02` as EventId;
const TASK_A = `tsk_${BODY}01` as TaskId;
const TASK_B = `tsk_${BODY}02` as TaskId;
const RUN_A = `run_${BODY}01` as RunId;
const RUN_B = `run_${BODY}02` as RunId;
const ADAPTER = 'mc' as AdapterId;
const SOURCE = 'mc.chat' as SourceId;

const fixtures: Array<{ dir: string; store: Store }> = [];

function openFixture(): Store {
  const dir = makeTempDir('sh-scope-');
  const store = openStore({ file: dbPathIn(dir) });
  migrate(store);
  fixtures.push({ dir, store });
  return store;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) {
      continue;
    }
    try {
      fixture.store.close();
    } catch {
      // Already closed by the test.
    }
    removeTempDir(fixture.dir);
  }
});

function repos(store: Store) {
  return createRepositories(store);
}

function seedTwoPersonas(store: Store): void {
  const r = repos(store);
  for (const [id, name] of [
    [A, 'A'],
    [B, 'B'],
  ] as const) {
    r.personas.insert({ id, displayName: name, state: 'RUNNING', createdAt: NOW, updatedAt: NOW });
  }
}

function seedSessions(store: Store): void {
  const r = repos(store);
  r.sessions.insert({
    id: SESSION_A,
    personaId: A,
    adapterId: ADAPTER,
    externalId: 'ext-a',
    openedAt: NOW,
  });
  r.sessions.insert({
    id: SESSION_B,
    personaId: B,
    adapterId: ADAPTER,
    externalId: 'ext-b',
    openedAt: NOW,
  });
}

function seedEvents(store: Store): void {
  const r = repos(store);
  for (const [id, personaId, ref] of [
    [EVENT_A, A, 'ref-a'],
    [EVENT_B, B, 'ref-b'],
  ] as const) {
    r.events.insert({
      id,
      personaId,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: ref,
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });
  }
}

function seedRunningTasks(store: Store): void {
  const r = repos(store);
  r.tasks.insertQueuedTask({ id: TASK_A, personaId: A, kind: 'thought.run', channel: 'inner' });
  r.tasks.insertQueuedTask({ id: TASK_B, personaId: B, kind: 'thought.run', channel: 'inner' });
  expect(
    r.tasks.claimNext({
      personaId: A,
      channel: 'inner',
      now: NOW,
      runId: RUN_A,
      maxAttempts: 3,
      kinds: ['thought.run'],
    })?.id,
  ).toBe(TASK_A);
  expect(
    r.tasks.claimNext({
      personaId: B,
      channel: 'inner',
      now: NOW,
      runId: RUN_B,
      maxAttempts: 3,
      kinds: ['thought.run'],
    })?.id,
  ).toBe(TASK_B);
}

function seedExhaustedQueued(store: Store): void {
  repos(store).tasks.insertQueuedTask({
    id: `tsk_${BODY}03` as TaskId,
    personaId: B,
    kind: 'thought.run',
    channel: 'inner',
  });
  withWrite(store, (tx) => {
    tx.prepare('UPDATE tasks SET attempt = 3 WHERE id = ?').run(`tsk_${BODY}03`);
  });
}

describe('sessions are persona-scoped', () => {
  it('A cannot read B by session id', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedSessions(store);

    expect(repos(store).sessions.getById({ personaId: A, id: SESSION_B })).toBeNull();
    expect(repos(store).sessions.getById({ personaId: B, id: SESSION_B })?.personaId).toBe(B);
  });

  it('A cannot close B, and B still closes its own session', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedSessions(store);

    expect(repos(store).sessions.close({ personaId: A, id: SESSION_B, closedAt: NOW + 1 })).toBe(
      false,
    );
    expect(repos(store).sessions.getById({ personaId: B, id: SESSION_B })?.closedAt).toBeNull();

    expect(repos(store).sessions.close({ personaId: B, id: SESSION_B, closedAt: NOW + 2 })).toBe(
      true,
    );
    expect(repos(store).sessions.getById({ personaId: B, id: SESSION_B })?.closedAt).toBe(NOW + 2);
  });

  it('openActive never reuses another persona’s open mapping', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedSessions(store);

    const opened = repos(store).sessions.openActive({
      id: `ses_${BODY}03` as SessionId,
      personaId: B,
      adapterId: ADAPTER,
      externalId: 'ext-a',
      openedAt: NOW + 5,
    });

    expect(opened.created).toBe(true);
    expect(opened.session.id).not.toBe(SESSION_A);
    expect(opened.session.personaId).toBe(B);
  });

  it('rejects a malformed persona id before touching the row', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedSessions(store);

    try {
      repos(store).sessions.getById({ personaId: 'psn_bad' as PersonaId, id: SESSION_B });
      throw new Error('expected an invalid identifier failure');
    } catch (error) {
      expect(isPersistenceError(error) && error.code).toBe('invalid_identifier');
    }
    expect(repos(store).sessions.getById({ personaId: B, id: SESSION_B })?.closedAt).toBeNull();
  });
});

describe('events are persona-scoped', () => {
  it('A cannot read B by event id', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedEvents(store);

    expect(repos(store).events.getById({ personaId: A, id: EVENT_B })).toBeNull();
    expect(repos(store).events.getById({ personaId: B, id: EVENT_B })?.personaId).toBe(B);
  });

  it('A cannot update B, and the row stays byte-identical', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedEvents(store);
    const before = repos(store).events.getById({ personaId: B, id: EVENT_B });

    expect(
      repos(store).events.updateStatus({
        id: EVENT_B,
        personaId: A,
        status: 'rejected',
        statusReason: 'auth_failed',
        attentionOutcome: null,
        updatedAt: NOW + 10,
      }),
    ).toBeNull();
    expect(repos(store).events.getById({ personaId: B, id: EVENT_B })).toStrictEqual(before);

    expect(
      repos(store).events.updateStatus({
        id: EVENT_B,
        personaId: B,
        status: 'rejected',
        statusReason: 'auth_failed',
        attentionOutcome: null,
        updatedAt: NOW + 10,
      }),
    ).toMatchObject({ status: 'rejected', updatedAt: NOW + 10 });
  });

  it('a committed P1 envelope is readable only under its own persona', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    const eventId = `evt_${BODY}04` as EventId;

    repos(store).events.commitP1Envelope({
      id: eventId,
      personaId: B,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'ref-commit-b',
      receivedAt: NOW,
      updatedAt: NOW,
      outcome: { status: 'accepted' },
    });

    expect(repos(store).events.getById({ personaId: A, id: eventId })).toBeNull();
    expect(repos(store).events.getById({ personaId: B, id: eventId })?.status).toBe('accepted');
  });
});

describe('tasks are persona-scoped', () => {
  it('A cannot read B by task id', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedRunningTasks(store);

    expect(repos(store).tasks.getById({ personaId: A, id: TASK_B })).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: TASK_B })?.personaId).toBe(B);
  });

  it('A cannot complete B even with the right run_id and attempt', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedRunningTasks(store);
    const before = repos(store).tasks.getById({ personaId: B, id: TASK_B });

    expect(
      repos(store).tasks.completeTask({
        id: TASK_B,
        personaId: A,
        runId: RUN_B,
        expectedAttempt: 1,
        finishedAt: NOW + 20,
      }),
    ).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: TASK_B })).toStrictEqual(before);

    expect(
      repos(store).tasks.completeTask({
        id: TASK_B,
        personaId: B,
        runId: RUN_B,
        expectedAttempt: 1,
        finishedAt: NOW + 20,
      }),
    ).toMatchObject({ state: 'done', finishedAt: NOW + 20 });
  });

  it('A cannot fail B, and B can still fail its own run', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedRunningTasks(store);
    const before = repos(store).tasks.getById({ personaId: B, id: TASK_B });

    expect(
      repos(store).tasks.failTask({
        id: TASK_B,
        personaId: A,
        runId: RUN_B,
        expectedAttempt: 1,
        maxAttempts: 3,
        retry: false,
        finishedAt: NOW + 30,
        nextScheduledAt: null,
      }),
    ).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: TASK_B })).toStrictEqual(before);

    expect(
      repos(store).tasks.failTask({
        id: TASK_B,
        personaId: B,
        runId: RUN_B,
        expectedAttempt: 1,
        maxAttempts: 3,
        retry: false,
        finishedAt: NOW + 30,
        nextScheduledAt: null,
      }),
    ).toMatchObject({ state: 'failed' });
  });

  it('A cannot fail an exhausted B task, and B can', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedExhaustedQueued(store);
    const exhausted = `tsk_${BODY}03` as TaskId;
    const before = repos(store).tasks.getById({ personaId: B, id: exhausted });

    expect(
      repos(store).tasks.failExhaustedTask({
        id: exhausted,
        personaId: A,
        expectedState: 'queued',
        expectedAttempt: 3,
        maxAttempts: 3,
        finishedAt: NOW + 40,
      }),
    ).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: exhausted })).toStrictEqual(before);

    expect(
      repos(store).tasks.failExhaustedTask({
        id: exhausted,
        personaId: B,
        expectedState: 'queued',
        expectedAttempt: 3,
        maxAttempts: 3,
        finishedAt: NOW + 40,
      }),
    ).toMatchObject({ state: 'failed', finishedAt: NOW + 40 });
  });

  it('A cannot pause or cancel B, and B can', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedRunningTasks(store);
    repos(store).tasks.insertQueuedTask({
      id: `tsk_${BODY}05` as TaskId,
      personaId: B,
      kind: 'thought.run',
      channel: 'inner',
    });
    const queued = `tsk_${BODY}05` as TaskId;

    // Every non-persona guard matches: queued state, valid attempt, right pair.
    expect(
      repos(store).tasks.setTaskState({
        id: queued,
        personaId: A,
        expectedState: 'queued',
        nextState: 'paused',
        at: NOW + 50,
      }),
    ).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: queued })?.state).toBe('queued');

    expect(
      repos(store).tasks.setTaskState({
        id: queued,
        personaId: B,
        expectedState: 'queued',
        nextState: 'paused',
        at: NOW + 52,
      }),
    ).toMatchObject({ state: 'paused' });

    expect(
      repos(store).tasks.setTaskState({
        id: queued,
        personaId: A,
        expectedState: 'paused',
        nextState: 'cancelled',
        at: NOW + 53,
      }),
    ).toBeNull();
    expect(repos(store).tasks.getById({ personaId: B, id: queued })?.state).toBe('paused');

    expect(
      repos(store).tasks.setTaskState({
        id: queued,
        personaId: B,
        expectedState: 'paused',
        nextState: 'cancelled',
        at: NOW + 54,
      }),
    ).toMatchObject({ state: 'cancelled', finishedAt: NOW + 54 });
  });

  it('rejects a malformed persona id before any write', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    seedRunningTasks(store);

    try {
      repos(store).tasks.completeTask({
        id: TASK_B,
        personaId: 'psn_bad' as PersonaId,
        runId: RUN_B,
        expectedAttempt: 1,
        finishedAt: NOW + 60,
      });
      throw new Error('expected an invalid_argument failure');
    } catch (error) {
      expect(isPersistenceError(error) && error.code).toBe('invalid_argument');
    }
    expect(repos(store).tasks.getById({ personaId: B, id: TASK_B })?.state).toBe('running');
  });
});

describe('other persona-owned repositories', () => {
  it('runtime_state is already keyed by persona', () => {
    const store = openFixture();
    seedTwoPersonas(store);
    repos(store).runtimeState.upsert({
      personaId: A,
      state: 'RUNNING',
      epoch: 1,
      updatedAt: NOW,
    });

    expect(repos(store).runtimeState.get(B)).toBeNull();
    expect(repos(store).runtimeState.get(A)?.personaId).toBe(A);
  });

  it('keeps personas global: the persona id is its own identity', () => {
    const store = openFixture();
    seedTwoPersonas(store);

    // System-level by design: `personas` has no parent persona to scope against.
    expect(repos(store).personas.getById(A)?.displayName).toBe('A');
    expect(repos(store).personas.getById(B)?.displayName).toBe('B');
  });
});
