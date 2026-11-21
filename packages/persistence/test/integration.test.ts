/**
 * Integration acceptance for the Persistence package (SH-006D).
 *
 * These tests exercise the pieces *together* — open → migrate → repositories →
 * checkpoint → close → reopen — on real SQLite files. Per-unit behaviour lives
 * in the focused suites; anything already proven there is referenced from the
 * delivery report instead of duplicated here.
 */

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
import {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  createRepositories,
  isStoreUnusable,
  migrate,
  openStore,
  verifySchema,
  withWrite,
  type Repositories,
  type Store,
} from '../src/index.js';
import { setReadGuardFaultForTests } from '../src/tx/read-guard-fault.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';
import { seedEvent } from './helpers/event-seed.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as PersonaId;
const SESSION = 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE' as SessionId;
const EVENT = 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH' as EventId;
const TASK = 'tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF' as TaskId;
const ADAPTER = 'minecraft' as AdapterId;
const SOURCE = 'minecraft.chat' as SourceId;

const dirs: string[] = [];
const opened: Store[] = [];

afterEach(() => {
  setReadGuardFaultForTests(null);
  while (opened.length > 0) {
    (opened.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
  closeAll();
});

function tempFile(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dbPathIn(dir);
}

function openRaw(file: string): Store {
  const store = openStore({ file });
  opened.push(store);
  return store;
}

function openAndMigrate(file: string): Store {
  const store = openRaw(file);
  migrate(store);
  return store;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

function count(store: Store, table: string): number {
  const rows = allRows<{ n: number }>(
    databaseOf(store).prepare(`SELECT count(*) AS n FROM ${table}`),
  );
  return rows[0]?.n ?? -1;
}

function seedPersona(repos: Repositories, epoch = 1): void {
  repos.personas.insert({
    id: PERSONA,
    displayName: 'Primary',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repos.runtimeState.upsert({ personaId: PERSONA, state: 'RUNNING', epoch, updatedAt: NOW });
}

describe('whole package, real file, two process lifetimes', () => {
  it('migrates, writes through every table, then reads it all back after reopen', () => {
    const file = tempFile();

    const first = openRaw(file);
    const applied = migrate(first);
    expect(applied.applied).toStrictEqual([1]);
    expect(applied.currentVersion).toBe(1);
    verifySchema(first);

    const repos = createRepositories(first);
    seedPersona(repos);
    repos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'mc:one',
      openedAt: NOW,
    });
    seedEvent(first, {
      id: EVENT,
      personaId: PERSONA,
      sessionId: SESSION,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    repos.tasks.insertQueuedTask({
      id: TASK,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
      payloadRefs: { eventId: EVENT },
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'e2e:1' },
      updatedAt: NOW + 5,
    });
    first.close();

    // Second "process": open, migrate again (idempotent), read everything.
    const second = openRaw(file);
    const again = migrate(second);
    expect(again.applied).toStrictEqual([]);
    expect(again.alreadyApplied).toStrictEqual([1]);
    verifySchema(second);

    const reposTwo = createRepositories(second);
    expect(reposTwo.personas.getById(PERSONA)?.displayName).toBe('Primary');
    expect(reposTwo.sessions.getById({ personaId: PERSONA, id: SESSION })?.externalId).toBe(
      'mc:one',
    );
    expect(reposTwo.events.getById({ personaId: PERSONA, id: EVENT })?.status).toBe('accepted');
    expect(reposTwo.tasks.getById({ personaId: PERSONA, id: TASK })?.payloadJson).toStrictEqual({
      eventId: EVENT,
    });
    expect(reposTwo.schemaMigrations.getLatest()?.version).toBe(1);

    const checkpoint = reposTwo.checkpoints.load(PERSONA);
    expect(checkpoint.status).toBe('present');
    if (checkpoint.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(checkpoint.stored.checkpoint.refs?.cursor).toBe('e2e:1');
    expect(checkpoint.stored.checkpoint.epoch).toBe(1);
  });

  it('closes idempotently and reopens with data intact', () => {
    const file = tempFile();

    const first = openAndMigrate(file);
    seedPersona(createRepositories(first));
    first.close();
    first.close();
    expect(first.isClosed).toBe(true);

    const second = openAndMigrate(file);
    expect(createRepositories(second).personas.getById(PERSONA)?.state).toBe('RUNNING');
    expect(second.isClosed).toBe(false);
  });

  it('repositories captured before close refuse to touch the database afterwards', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos);

    store.close();

    expect(codeOf(() => repos.personas.getById(PERSONA))).toBe('store_closed');
    expect(codeOf(() => repos.sessions.listByPersona(PERSONA))).toBe('store_closed');
    expect(
      codeOf(() => repos.events.listByPersonaStatus({ personaId: PERSONA, status: 'accepted' })),
    ).toBe('store_closed');
    expect(
      codeOf(() => repos.tasks.listByPersonaState({ personaId: PERSONA, state: 'queued' })),
    ).toBe('store_closed');
    expect(codeOf(() => repos.runtimeState.get(PERSONA))).toBe('store_closed');
    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('store_closed');
    expect(codeOf(() => repos.schemaMigrations.listApplied())).toBe('store_closed');
  });
});

describe('migration integrity at the integration boundary', () => {
  it('refuses to start when an applied checksum no longer matches, and does not repair it', () => {
    const file = tempFile();

    const first = openAndMigrate(file);
    seedPersona(createRepositories(first));
    first.close();

    const tamper = openRaw(file);
    databaseOf(tamper)
      .prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1')
      .run('deadbeef');
    tamper.close();

    const second = openRaw(file);
    expect(codeOf(() => migrate(second))).toBe('migration_checksum_mismatch');

    const row = allRows<{ checksum: string }>(
      databaseOf(second).prepare('SELECT checksum FROM schema_migrations WHERE version = 1'),
    )[0];
    expect(row?.checksum).toBe('deadbeef');
    expect(count(second, 'personas')).toBe(1);
  });
});

describe('transaction boundaries hold when repositories are combined', () => {
  it('keeps every table consistent while repositories interleave on one store', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos);

    repos.sessions.insert({
      id: SESSION,
      personaId: PERSONA,
      adapterId: ADAPTER,
      externalId: 'mc:one',
      openedAt: NOW,
    });
    seedEvent(store, {
      id: EVENT,
      personaId: PERSONA,
      sessionId: SESSION,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'mc-1',
      status: 'accepted',
      receivedAt: NOW,
      updatedAt: NOW,
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'interleaved' },
      updatedAt: NOW + 1,
    });
    repos.personas.updateState({ id: PERSONA, state: 'SUSPENDED', updatedAt: NOW + 2 });
    repos.events.expireActive({
      id: EVENT,
      personaId: PERSONA,
      updatedAt: NOW + 3,
      reason: 'ttl_expired',
    });
    repos.tasks.insertQueuedTask({
      id: TASK,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
    });
    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'DRAINING',
      epoch: 1,
      updatedAt: NOW + 4,
    });

    // Each repository owns its own columns: nothing was clobbered.
    expect(repos.personas.getById(PERSONA)?.state).toBe('SUSPENDED');
    expect(repos.personas.getById(PERSONA)?.version).toBe(1);
    expect(repos.events.getById({ personaId: PERSONA, id: EVENT })?.status).toBe('expired');
    expect(repos.events.getById({ personaId: PERSONA, id: EVENT })?.statusReason).toBe(
      'ttl_expired',
    );
    expect(repos.sessions.getById({ personaId: PERSONA, id: SESSION })?.closedAt).toBeNull();
    expect(repos.tasks.getById({ personaId: PERSONA, id: TASK })?.state).toBe('queued');
    expect(repos.runtimeState.get(PERSONA)?.state).toBe('DRAINING');
    expect(repos.runtimeState.get(PERSONA)?.epoch).toBe(1);

    const checkpoint = repos.checkpoints.load(PERSONA);
    expect(checkpoint.status).toBe('present');
    if (checkpoint.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(checkpoint.stored.checkpoint.refs?.cursor).toBe('interleaved');
  });

  it('refuses repository writes inside an open transaction and commits nothing', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos);

    withWrite(store, () => {
      expect(
        codeOf(() =>
          repos.events.commitP1Envelope({
            id: EVENT,
            personaId: PERSONA,
            source: SOURCE,
            adapterId: ADAPTER,
            adapterEventRef: 'mc-1',
            receivedAt: NOW,
            updatedAt: NOW,
            outcome: { status: 'accepted' },
          }),
        ),
      ).toBe('nested_write');

      expect(
        codeOf(() =>
          repos.tasks.insertQueuedTask({
            id: TASK,
            personaId: PERSONA,
            kind: 'thought.run',
            channel: 'inner',
          }),
        ),
      ).toBe('nested_write');

      expect(
        codeOf(() =>
          repos.checkpoints.save({
            personaId: PERSONA,
            epoch: 1,
            refs: { cursor: 'nested' },
            updatedAt: NOW + 1,
          }),
        ),
      ).toBe('nested_write');
    });

    expect(count(store, 'events')).toBe(0);
    expect(count(store, 'tasks')).toBe(0);
    expect(repos.checkpoints.load(PERSONA)).toStrictEqual({ status: 'absent' });
  });

  it('rolls back every table when an outer transaction fails midway', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'stable' },
      updatedAt: NOW + 1,
    });

    expect(() =>
      withWrite(store, (tx) => {
        tx.prepare(
          'INSERT INTO sessions (id, persona_id, adapter_id, opened_at) VALUES (?, ?, ?, ?)',
        ).run(SESSION, PERSONA, ADAPTER, NOW);
        tx.prepare(
          'INSERT INTO tasks (id, persona_id, kind, channel, state) VALUES (?, ?, ?, ?, ?)',
        ).run(TASK, PERSONA, 'thought.run', 'inner', 'queued');
        tx.prepare('UPDATE runtime_state SET checkpoint_json = ? WHERE persona_id = ?').run(
          'half-written',
          PERSONA,
        );
        throw new Error('abort the transaction');
      }),
    ).toThrow('abort the transaction');

    expect(count(store, 'sessions')).toBe(0);
    expect(count(store, 'tasks')).toBe(0);
    const checkpoint = repos.checkpoints.load(PERSONA);
    expect(checkpoint.status).toBe('present');
    if (checkpoint.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(checkpoint.stored.checkpoint.refs?.cursor).toBe('stable');
  });

  it('rejects every repository once the store is unusable', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos);

    setReadGuardFaultForTests((stage) =>
      stage === 'restore' ? new Error('simulated restore failure') : null,
    );
    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);

    const attempts: ReadonlyArray<readonly [string, () => unknown]> = [
      ['personas.getById', () => repos.personas.getById(PERSONA)],
      ['sessions.listByPersona', () => repos.sessions.listByPersona(PERSONA)],
      [
        'events.listByPersonaStatus',
        () => repos.events.listByPersonaStatus({ personaId: PERSONA, status: 'accepted' }),
      ],
      [
        'tasks.listByPersonaState',
        () => repos.tasks.listByPersonaState({ personaId: PERSONA, state: 'queued' }),
      ],
      ['runtimeState.get', () => repos.runtimeState.get(PERSONA)],
      ['schemaMigrations.listApplied', () => repos.schemaMigrations.listApplied()],
      ['checkpoints.load', () => repos.checkpoints.load(PERSONA)],
      [
        'checkpoints.save',
        () =>
          repos.checkpoints.save({
            personaId: PERSONA,
            epoch: 1,
            refs: { cursor: 'nope' },
            updatedAt: NOW + 1,
          }),
      ],
    ];

    for (const [label, attempt] of attempts) {
      expect(codeOf(attempt), label).toBe('store_unusable');
    }
  });
});

describe('checkpoint lifecycle across a real reopen', () => {
  it('reads the checkpoint back, then flags an epoch bump as stale', () => {
    const file = tempFile();

    const first = openAndMigrate(file);
    const repos = createRepositories(first);
    seedPersona(repos, 2);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 2,
      refs: { cursor: 'restart' },
      updatedAt: NOW + 1,
    });
    first.close();

    const second = openAndMigrate(file);
    const reposTwo = createRepositories(second);

    const loaded = reposTwo.checkpoints.load(PERSONA);
    expect(loaded.status).toBe('present');
    if (loaded.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(loaded.stored.checkpoint.epoch).toBe(2);
    expect(loaded.stored.checkpoint.refs?.cursor).toBe('restart');

    // Content epoch bumped (erasure): the checkpoint is now older than the persona.
    reposTwo.runtimeState.upsert({
      personaId: PERSONA,
      state: 'RUNNING',
      epoch: 3,
      updatedAt: NOW + 2,
    });

    expect(reposTwo.checkpoints.load(PERSONA)).toStrictEqual({
      status: 'stale',
      checkpointEpoch: 2,
      currentEpoch: 3,
    });

    expect(
      codeOf(() =>
        reposTwo.checkpoints.save({
          personaId: PERSONA,
          epoch: 2,
          refs: { cursor: 'too-old' },
          updatedAt: NOW + 3,
        }),
      ),
    ).toBe('checkpoint_epoch_mismatch');
  });

  it('does not hide or repair a stored checkpoint it cannot interpret', () => {
    const file = tempFile();
    const unsupported = JSON.stringify({
      schema: 'soul.runtime.checkpoint.v2',
      version: 2,
      epoch: 1,
    });

    const first = openAndMigrate(file);
    const repos = createRepositories(first);
    seedPersona(repos);
    databaseOf(first)
      .prepare('UPDATE runtime_state SET checkpoint_json = ? WHERE persona_id = ?')
      .run(unsupported, PERSONA);
    first.close();

    const second = openAndMigrate(file);
    const reposTwo = createRepositories(second);

    expect(codeOf(() => reposTwo.checkpoints.load(PERSONA))).toBe('checkpoint_version_unsupported');
    const raw = allRows<{ checkpoint_json: string | null }>(
      databaseOf(second).prepare('SELECT checkpoint_json FROM runtime_state WHERE persona_id = ?'),
      PERSONA,
    )[0]?.checkpoint_json;
    expect(raw).toBe(unsupported);
    expect(JSON.parse(raw ?? '{}')).toMatchObject({
      schema: 'soul.runtime.checkpoint.v2',
      version: 2,
    });
  });

  it('keeps the envelope stable across a write/read cycle', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    seedPersona(repos, 4);

    repos.checkpoints.save({ personaId: PERSONA, epoch: 4, updatedAt: NOW + 1 });
    const raw = allRows<{ checkpoint_json: string | null }>(
      databaseOf(store).prepare('SELECT checkpoint_json FROM runtime_state WHERE persona_id = ?'),
      PERSONA,
    )[0]?.checkpoint_json;

    expect(JSON.parse(raw ?? '{}')).toStrictEqual({
      schema: CHECKPOINT_SCHEMA,
      version: CHECKPOINT_VERSION,
      epoch: 4,
    });
  });
});
