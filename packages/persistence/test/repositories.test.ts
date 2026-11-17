import { afterEach, describe, expect, it } from 'vitest';
import type {
  AdapterId,
  EventId,
  PersonaId,
  SessionId,
  SourceId,
  TaskId,
} from '@soul-harness/contracts';

import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { createRepositories, withWrite, type Repositories } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as PersonaId;
const PERSONA_2 = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABD' as PersonaId;
const SESSION = 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE' as SessionId;
const EVENT = 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH' as EventId;
const TASK = 'tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF' as TaskId;
const ADAPTER = 'minecraft' as AdapterId;
const SOURCE = 'minecraft.chat' as SourceId;

interface Setup {
  readonly repos: Repositories;
  readonly store: ReturnType<typeof openMigratedStore>;
}

function setup(): Setup {
  const store = openMigratedStore();
  return { store, repos: createRepositories(store) };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

function seedPersona(repos: Repositories, id: PersonaId = PERSONA) {
  return repos.personas.insert({
    id,
    displayName: 'Primary',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('personas repository', () => {
  it('inserts and reads back with database defaults', () => {
    const { repos } = setup();
    const created = seedPersona(repos, PERSONA);

    expect(created).toMatchObject({
      id: PERSONA,
      displayName: 'Primary',
      state: 'RUNNING',
      version: 0,
      epoch: 1,
      bootId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(repos.personas.getById(PERSONA)).toStrictEqual(created);
  });

  it('returns null for an unknown persona', () => {
    const { repos } = setup();
    expect(repos.personas.getById(PERSONA)).toBeNull();
    expect(
      repos.personas.updateState({ id: PERSONA, state: 'STOPPED', updatedAt: NOW + 1 }),
    ).toBeNull();
  });

  it('bumps version on every state change', () => {
    const { repos } = setup();
    seedPersona(repos);

    const first = repos.personas.updateState({
      id: PERSONA,
      state: 'SUSPENDED',
      updatedAt: NOW + 1,
    });
    const second = repos.personas.updateState({
      id: PERSONA,
      state: 'RUNNING',
      updatedAt: NOW + 2,
    });

    expect(first?.version).toBe(1);
    expect(second?.version).toBe(2);
    expect(second?.state).toBe('RUNNING');
    expect(second?.updatedAt).toBe(NOW + 2);
  });

  it('pages list results and bounds the limit', () => {
    const { repos } = setup();
    seedPersona(repos, PERSONA);
    seedPersona(repos, PERSONA_2);

    expect(repos.personas.list(1)).toHaveLength(1);
    expect(repos.personas.list()).toHaveLength(2);
    expect(codeOf(() => repos.personas.list(0))).toBe('invalid_argument');
    expect(codeOf(() => repos.personas.list(501))).toBe('invalid_argument');
  });
});

describe('sessions repository', () => {
  it('stores meta JSON with a schema marker', () => {
    const { repos } = setup();
    seedPersona(repos);

    const session = repos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'qq:group-1',
      openedAt: NOW,
      metaJson: { groupName: 'test' },
    });

    expect(session.metaJson).toStrictEqual({ groupName: 'test' });
    expect(session.closedAt).toBeNull();
  });

  it('finds the active mapping and forgets it after close', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'qq:group-1',
      openedAt: NOW,
    });

    const find = () =>
      repos.sessions.findActiveByExternal({
        personaId: PERSONA,
        adapterId: ADAPTER,
        externalId: 'qq:group-1',
      });

    expect(find()?.id).toBe(SESSION);
    expect(repos.sessions.close({ id: SESSION, closedAt: NOW + 1 })).toBe(true);
    expect(repos.sessions.close({ id: SESSION, closedAt: NOW + 2 })).toBe(false);
    expect(find()).toBeNull();
  });

  it('allows a new session for the same external reference once the old one closed', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'qq:group-1',
      openedAt: NOW,
    });
    repos.sessions.close({ id: SESSION, closedAt: NOW + 1 });

    const reopened = repos.sessions.insert({
      id: 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDF' as SessionId,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'qq:group-1',
      openedAt: NOW + 2,
    });

    expect(reopened.id).not.toBe(SESSION);
    expect(
      repos.sessions.findActiveByExternal({
        personaId: PERSONA,
        adapterId: ADAPTER,
        externalId: 'qq:group-1',
      })?.id,
    ).toBe(reopened.id);
  });
});

describe('events repository', () => {
  it('inserts with the P1 archive defaults and no way to set them', () => {
    const { repos } = setup();
    seedPersona(repos);

    const event = repos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(event.archiveRef).toBeNull();
    expect(event.archiveDisposition).toBeNull();
    expect(event.archiveState).toBe('none');
    expect(event.attentionOutcome).toBeNull();
    expect(event.statusReason).toBeNull();
  });

  it('finds the event by its dedupe key', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      repos.events.findByDedupeKey({
        personaId: PERSONA,
        adapterId: ADAPTER,
        source: SOURCE,
        adapterEventRef: 'mc-1',
      })?.id,
    ).toBe(EVENT);

    expect(
      repos.events.findByDedupeKey({
        personaId: PERSONA,
        adapterId: 'qq' as AdapterId,
        source: SOURCE,
        adapterEventRef: 'mc-1',
      }),
    ).toBeNull();
  });

  it('updates status with an explicit reason code', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    const updated = repos.events.updateStatus({
      id: EVENT,
      status: 'expired',
      statusReason: 'ttl_expired',
      attentionOutcome: 'ignored',
      updatedAt: NOW + 5,
    });

    expect(updated?.status).toBe('expired');
    expect(updated?.statusReason).toBe('ttl_expired');
    expect(updated?.attentionOutcome).toBe('ignored');
    expect(updated?.updatedAt).toBe(NOW + 5);
  });

  it('rejects a terminal status without a reason (database CHECK)', () => {
    const { repos } = setup();
    seedPersona(repos);

    expect(
      codeOf(() =>
        repos.events.insert({
          id: EVENT,
          personaId: PERSONA,
          source: SOURCE,
          adapterId: ADAPTER,
          adapterEventRef: 'mc-1',
          status: 'expired',
          receivedAt: NOW,
          updatedAt: NOW,
        }),
      ),
    ).toBe('check_violation');
  });

  it('filters list results by persona and status', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.events.insert({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });

    expect(
      repos.events.listByPersonaStatus({ personaId: PERSONA, status: 'accepted' }),
    ).toHaveLength(1);
    expect(
      repos.events.listByPersonaStatus({ personaId: PERSONA, status: 'noticed' }),
    ).toHaveLength(0);
  });
});

describe('tasks repository', () => {
  it('round-trips payload JSON', () => {
    const { repos } = setup();
    seedPersona(repos);

    const task = repos.tasks.insert({
      id: TASK,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
      state: 'queued',
      priority: 5,
      payloadJson: { eventId: EVENT },
      scheduledAt: NOW,
    });

    expect(task.payloadJson).toStrictEqual({ eventId: EVENT });
    expect(task.priority).toBe(5);
    expect(task.attempt).toBe(0);
    expect(task.startedAt).toBeNull();
  });

  it('updates state with explicit timestamps', () => {
    const { repos } = setup();
    seedPersona(repos);
    repos.tasks.insert({
      id: TASK,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
      state: 'queued',
    });

    const running = repos.tasks.updateState({
      id: TASK,
      state: 'running',
      startedAt: NOW + 1,
      finishedAt: null,
      attempt: 1,
    });
    expect(running?.startedAt).toBe(NOW + 1);
    expect(running?.attempt).toBe(1);

    const done = repos.tasks.updateState({
      id: TASK,
      state: 'done',
      startedAt: NOW + 1,
      finishedAt: NOW + 9,
      attempt: 1,
    });
    expect(done?.finishedAt).toBe(NOW + 9);
    expect(repos.tasks.listByPersonaState({ personaId: PERSONA, state: 'done' })).toHaveLength(1);
    expect(
      repos.tasks.updateState({
        id: 'tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDG' as TaskId,
        state: 'done',
        startedAt: null,
        finishedAt: null,
        attempt: 0,
      }),
    ).toBeNull();
  });
});

describe('runtime_state repository', () => {
  it('upserts lifecycle state without touching the checkpoint column', () => {
    const { repos, store } = setup();
    seedPersona(repos);

    const created = repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'BOOTING',
      epoch: 1,
      updatedAt: NOW,
    });
    expect(created.state).toBe('BOOTING');

    databaseOf(store)
      .prepare('UPDATE runtime_state SET checkpoint_json = ? WHERE persona_id = ?')
      .run('{"schema":"soul.checkpoint.v1"}', PERSONA);

    const updated = repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'RUNNING',
      epoch: 1,
      updatedAt: NOW + 1,
    });
    expect(updated.state).toBe('RUNNING');

    const checkpoint = allRows<{ checkpoint_json: string | null }>(
      databaseOf(store).prepare('SELECT checkpoint_json FROM runtime_state WHERE persona_id = ?'),
      PERSONA,
    )[0]?.checkpoint_json;
    expect(checkpoint).toBe('{"schema":"soul.checkpoint.v1"}');
  });

  it('returns null when the persona has no runtime state', () => {
    const { repos } = setup();
    expect(repos.runtimeState.get(PERSONA)).toBeNull();
  });
});

describe('schema_migrations repository is read-only', () => {
  it('exposes no write method at all', () => {
    const { repos } = setup();
    expect(Object.keys(repos.schemaMigrations).sort()).toStrictEqual(['getLatest', 'listApplied']);
  });

  it('reports what the migrator applied', () => {
    const { repos } = setup();
    expect(repos.schemaMigrations.listApplied().map((row) => row.version)).toStrictEqual([1]);
    expect(repos.schemaMigrations.getLatest()?.version).toBe(1);
  });
});

describe('database errors are classified', () => {
  it('unique_conflict for a duplicate primary key', () => {
    const { repos } = setup();
    seedPersona(repos);

    expect(codeOf(() => seedPersona(repos))).toBe('unique_conflict');
  });

  it('foreign_key_violation for an unknown persona', () => {
    const { repos } = setup();

    expect(
      codeOf(() =>
        repos.events.insert({
          id: EVENT,
          personaId: PERSONA,
          source: SOURCE,
          adapterId: ADAPTER,
          adapterEventRef: 'mc-1',
          status: 'accepted',
          receivedAt: NOW,
          updatedAt: NOW,
        }),
      ),
    ).toBe('foreign_key_violation');
  });

  it('not_null_violation for a missing required column', () => {
    const { repos } = setup();

    expect(
      codeOf(() =>
        repos.personas.insert({
          id: PERSONA,
          displayName: null as unknown as string,
          state: 'RUNNING',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
    ).toBe('not_null_violation');
  });
});

describe('repository writes go through the single write entry', () => {
  it('a write inside an open transaction is refused as nested_write', () => {
    const { repos, store } = setup();

    withWrite(store, () => {
      expect(codeOf(() => seedPersona(repos))).toBe('nested_write');
    });

    expect(repos.personas.getById(PERSONA)).toBeNull();
  });

  it('reads keep working inside an open transaction', () => {
    const { repos, store } = setup();

    withWrite(store, () => {
      expect(repos.personas.list()).toStrictEqual([]);
    });
  });
});
