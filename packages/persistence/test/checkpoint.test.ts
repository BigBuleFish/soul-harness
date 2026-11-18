import { afterEach, describe, expect, it } from 'vitest';
import type { PersonaId, RunId, ThreadId } from '@soul-harness/contracts';

import {
  CHECKPOINT_MAX_BYTES,
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  createRepositories,
  decodeCheckpoint,
  encodeCheckpoint,
  isStoreUnusable,
  migrate,
  openStore,
  type Repositories,
  type Store,
  withWrite,
} from '../src/index.js';
import { allRows } from '../src/db/rows.js';
import { databaseOf } from '../src/db/store.js';
import type { PersistenceError } from '../src/errors.js';
import { setReadGuardFaultForTests } from '../src/tx/read-guard-fault.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as PersonaId;
const THREAD = 'thr_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as ThreadId;
const THREAD_2 = 'thr_01JQ8Z3K5M7P9R2T4V6X8Z0ABD' as ThreadId;
const RUN = 'run_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as RunId;

const extraStores: Store[] = [];
const extraDirs: string[] = [];

afterEach(() => {
  setReadGuardFaultForTests(null);
  while (extraStores.length > 0) {
    (extraStores.pop() as Store).close();
  }
  while (extraDirs.length > 0) {
    removeTempDir(extraDirs.pop() as string);
  }
  closeAll();
});

interface RuntimeRow {
  readonly state: string;
  readonly boot_id: string | null;
  readonly epoch: number;
  readonly checkpoint_json: string | null;
  readonly updated_at: number;
}

function setup(epoch = 1): { store: Store; repos: Repositories } {
  const store = openMigratedStore();
  const repos = createRepositories(store);

  repos.personas.insert({
    id: PERSONA,
    displayName: 'Primary',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repos.runtimeState.upsert({
    personaId: PERSONA,
    state: 'RUNNING',
    epoch,
    updatedAt: NOW,
  });

  return { store, repos };
}

function runtimeRow(store: Store): RuntimeRow | undefined {
  return allRows<RuntimeRow>(
    databaseOf(store).prepare(
      'SELECT state, boot_id, epoch, checkpoint_json, updated_at FROM runtime_state WHERE persona_id = ?',
    ),
    PERSONA,
  )[0];
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as PersistenceError).code;
  }
  throw new Error('expected the call to throw');
}

function writeRawCheckpoint(store: Store, text: string): void {
  databaseOf(store)
    .prepare('UPDATE runtime_state SET checkpoint_json = ? WHERE persona_id = ?')
    .run(text, PERSONA);
}

describe('checkpoint lifecycle', () => {
  it('reports an absent checkpoint before anything is saved', () => {
    const { store, repos } = setup();

    expect(repos.checkpoints.load(PERSONA)).toStrictEqual({ status: 'absent' });
    expect(runtimeRow(store)?.checkpoint_json).toBeNull();
  });

  it('saves and reads back a checkpoint', () => {
    const { store, repos } = setup(3);

    const saved = repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 3,
      refs: { cursor: 'sched:0:17', threadIds: [THREAD, THREAD_2], runIds: [RUN] },
      updatedAt: NOW + 10,
    });

    expect(saved.checkpoint.epoch).toBe(3);
    expect(saved.savedAt).toBe(NOW + 10);

    const loaded = repos.checkpoints.load(PERSONA);
    expect(loaded.status).toBe('present');
    if (loaded.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(loaded.stored.checkpoint.refs).toStrictEqual({
      cursor: 'sched:0:17',
      threadIds: [THREAD, THREAD_2],
      runIds: [RUN],
    });
    expect(loaded.stored.savedAt).toBe(NOW + 10);

    // The stored bytes really are the versioned envelope.
    const raw = runtimeRow(store)?.checkpoint_json ?? '';
    expect(JSON.parse(raw)).toStrictEqual({
      schema: CHECKPOINT_SCHEMA,
      version: CHECKPOINT_VERSION,
      epoch: 3,
      refs: { cursor: 'sched:0:17', threadIds: [THREAD, THREAD_2], runIds: [RUN] },
    });
  });

  it('keeps the checkpoint across a store reopen', () => {
    const dir = makeTempDir();
    extraDirs.push(dir);
    const file = dbPathIn(dir);

    const first = openStore({ file });
    extraStores.push(first);
    migrate(first);
    const reposOne = createRepositories(first);
    reposOne.personas.insert({
      id: PERSONA,
      displayName: 'Primary',
      state: 'RUNNING',
      createdAt: NOW,
      updatedAt: NOW,
    });
    reposOne.runtimeState.upsert({
      personaId: PERSONA,
      state: 'RUNNING',
      epoch: 2,
      updatedAt: NOW,
    });
    reposOne.checkpoints.save({
      personaId: PERSONA,
      epoch: 2,
      refs: { cursor: 'after-reboot' },
      updatedAt: NOW + 1,
    });
    first.close();

    const second = openStore({ file });
    extraStores.push(second);
    migrate(second);
    const reposTwo = createRepositories(second);

    const loaded = reposTwo.checkpoints.load(PERSONA);
    expect(loaded.status).toBe('present');
    if (loaded.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(loaded.stored.checkpoint.refs?.cursor).toBe('after-reboot');
    expect(loaded.stored.checkpoint.epoch).toBe(2);
  });

  it('replaces the checkpoint', () => {
    const { repos } = setup(1);

    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'first' },
      updatedAt: NOW + 1,
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'second' },
      updatedAt: NOW + 2,
    });

    const loaded = repos.checkpoints.load(PERSONA);
    expect(loaded.status).toBe('present');
    if (loaded.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(loaded.stored.checkpoint.refs?.cursor).toBe('second');
    expect(loaded.stored.savedAt).toBe(NOW + 2);
  });
});

describe('checkpoint and runtime_state do not clobber each other', () => {
  it('runtime_state upsert never clears or rewrites the checkpoint', () => {
    const { store, repos } = setup(1);

    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'keep-me' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'SUSPENDED',
      epoch: 1,
      updatedAt: NOW + 2,
    });

    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
    expect(runtimeRow(store)?.state).toBe('SUSPENDED');
    expect(repos.checkpoints.load(PERSONA).status).toBe('present');
  });

  it('saving a checkpoint leaves the lifecycle columns untouched', () => {
    const { store, repos } = setup(4);
    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'BOOTING',
      epoch: 4,
      updatedAt: NOW + 100,
    });

    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 4,
      refs: { cursor: 'c1' },
      updatedAt: NOW + 200,
    });

    const row = runtimeRow(store);
    expect(row?.state).toBe('BOOTING');
    expect(row?.epoch).toBe(4);
    expect(row?.boot_id).toBeNull();
    expect(row?.updated_at).toBe(NOW + 200);
  });

  it('interleaved updates do not lose data in either direction', () => {
    const { store, repos } = setup(1);

    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'RUNNING',
      epoch: 1,
      updatedAt: NOW + 1,
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'cp-1' },
      updatedAt: NOW + 2,
    });
    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'DRAINING',
      epoch: 1,
      updatedAt: NOW + 3,
    });
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'cp-2' },
      updatedAt: NOW + 4,
    });
    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'STOPPED',
      epoch: 1,
      updatedAt: NOW + 5,
    });

    const row = runtimeRow(store);
    expect(row?.state).toBe('STOPPED');
    expect(JSON.parse(row?.checkpoint_json ?? '{}').refs.cursor).toBe('cp-2');
    expect(repos.checkpoints.load(PERSONA).status).toBe('present');
  });
});

describe('damaged or unsupported checkpoints are errors, never "empty"', () => {
  it('rejects invalid JSON and leaves the row untouched', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(store, 'not-json-at-all');

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_invalid');
    expect(runtimeRow(store)?.checkpoint_json).toBe('not-json-at-all');
  });

  it('rejects a missing required field', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(store, JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 1 }));

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_invalid');
  });

  it('rejects a wrongly typed field', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(
      store,
      JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 1, epoch: '1' }),
    );

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_invalid');
  });

  it('rejects fields outside the envelope (content smuggling)', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(
      store,
      JSON.stringify({
        schema: CHECKPOINT_SCHEMA,
        version: 1,
        epoch: 1,
        content: 'the persona said hello',
      }),
    );

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_invalid');
  });

  it('rejects an unsupported schema version', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(
      store,
      JSON.stringify({ schema: 'soul.runtime.checkpoint.v2', version: 2, epoch: 1 }),
    );

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_version_unsupported');
  });

  it('rejects an unsupported numeric version under the same schema', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(store, JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 2, epoch: 1 }));

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_version_unsupported');
  });

  it('rejects an oversized stored checkpoint', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(store, 'x'.repeat(CHECKPOINT_MAX_BYTES + 1));

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_invalid');
  });
});

describe('epoch rules', () => {
  it('reports a stale checkpoint without deleting it', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'old' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    // Content epoch bumped by an erasure (DATA-MODEL §7).
    repos.runtimeState.upsert({
      personaId: PERSONA,
      state: 'RUNNING',
      epoch: 2,
      updatedAt: NOW + 2,
    });

    expect(repos.checkpoints.load(PERSONA)).toStrictEqual({
      status: 'stale',
      checkpointEpoch: 1,
      currentEpoch: 2,
    });
    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
  });

  it('refuses to save a checkpoint whose epoch does not match', () => {
    const { store, repos } = setup(5);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 5,
      refs: { cursor: 'current' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    expect(
      codeOf(() =>
        repos.checkpoints.save({
          personaId: PERSONA,
          epoch: 4,
          refs: { cursor: 'stale' },
          updatedAt: NOW + 2,
        }),
      ),
    ).toBe('checkpoint_epoch_mismatch');

    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
  });

  it('rejects a stored checkpoint whose epoch is ahead of the persona', () => {
    const { store, repos } = setup(1);
    writeRawCheckpoint(store, JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 1, epoch: 9 }));

    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('checkpoint_epoch_mismatch');
  });

  it('refuses to save without a runtime_state row', () => {
    const store = openMigratedStore();
    const repos = createRepositories(store);
    repos.personas.insert({
      id: PERSONA,
      displayName: 'Primary',
      state: 'CREATED',
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(
      codeOf(() => repos.checkpoints.save({ personaId: PERSONA, epoch: 1, updatedAt: NOW })),
    ).toBe('runtime_state_missing');
    expect(repos.checkpoints.load(PERSONA)).toStrictEqual({ status: 'absent' });
  });
});

describe('failures leave the previous checkpoint in place', () => {
  it('a rejected payload never reaches SQL', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'good' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    expect(
      codeOf(() =>
        repos.checkpoints.save({
          personaId: PERSONA,
          epoch: 1,
          refs: { cursor: 'has a space' },
          updatedAt: NOW + 2,
        }),
      ),
    ).toBe('checkpoint_invalid');

    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
  });

  it('a database failure mid-update rolls back and keeps the old checkpoint', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'original' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    databaseOf(store).exec(
      `CREATE TRIGGER block_checkpoint_update BEFORE UPDATE OF checkpoint_json ON runtime_state
       BEGIN SELECT RAISE(ABORT, 'blocked by test'); END;`,
    );

    let caught: unknown;
    try {
      repos.checkpoints.save({
        personaId: PERSONA,
        epoch: 1,
        refs: { cursor: 'never' },
        updatedAt: NOW + 2,
      });
    } catch (error) {
      caught = error;
    } finally {
      databaseOf(store).exec('DROP TRIGGER block_checkpoint_update');
    }

    expect((caught as PersistenceError).code).toBe('db_error');
    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
    expect(repos.checkpoints.load(PERSONA).status).toBe('present');
  });

  it('an outer transaction rollback also rolls back a checkpoint update', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'committed' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    // The column participates in the same transaction as every other write.
    expect(() =>
      withWriteGuard(store, () => {
        writeRawCheckpoint(store, 'half-written');
        throw new Error('abort the outer transaction');
      }),
    ).toThrow('abort the outer transaction');

    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
  });
});

describe('transaction boundaries follow SH-006B', () => {
  it('refuses to save inside an open transaction', () => {
    const { store, repos } = setup(1);

    expect(
      codeOf(() =>
        withWriteGuard(store, () => {
          repos.checkpoints.save({
            personaId: PERSONA,
            epoch: 1,
            refs: { cursor: 'nested' },
            updatedAt: NOW + 1,
          });
        }),
      ),
    ).toBe('nested_write');

    expect(repos.checkpoints.load(PERSONA).status).toBe('absent');
  });

  it('loads inside an open transaction and sees uncommitted state', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'before-tx' },
      updatedAt: NOW + 1,
    });

    const seen = withWriteGuard(store, () => {
      writeRawCheckpoint(
        store,
        JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 1, epoch: 1 }),
      );
      return repos.checkpoints.load(PERSONA);
    });

    expect(seen.status).toBe('present');
    if (seen.status !== 'present') {
      throw new Error('unreachable');
    }
    expect(seen.stored.checkpoint.refs).toBeUndefined();

    // The scope committed: the raw value written inside it is now on disk.
    expect(runtimeRow(store)?.checkpoint_json).toBe(
      JSON.stringify({ schema: CHECKPOINT_SCHEMA, version: 1, epoch: 1 }),
    );
  });

  it('is rejected once the store is unusable', () => {
    const { store, repos } = setup(1);
    repos.checkpoints.save({
      personaId: PERSONA,
      epoch: 1,
      refs: { cursor: 'stable' },
      updatedAt: NOW + 1,
    });
    const before = runtimeRow(store)?.checkpoint_json;

    setReadGuardFaultForTests((stage) =>
      stage === 'restore' ? new Error('simulated restore failure') : null,
    );
    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('store_unusable');
    expect(isStoreUnusable(store)).toBe(true);

    expect(
      codeOf(() =>
        repos.checkpoints.save({
          personaId: PERSONA,
          epoch: 1,
          refs: { cursor: 'nope' },
          updatedAt: NOW + 2,
        }),
      ),
    ).toBe('store_unusable');
    expect(codeOf(() => repos.checkpoints.load(PERSONA))).toBe('store_unusable');
    expect(runtimeRow(store)?.checkpoint_json).toBe(before);
  });
});

describe('envelope format helpers', () => {
  it('round-trips a checkpoint', () => {
    const text = encodeCheckpoint(2, { cursor: 'c', threadIds: [THREAD], runIds: [RUN] });
    expect(decodeCheckpoint(text)).toStrictEqual({
      schema: CHECKPOINT_SCHEMA,
      version: CHECKPOINT_VERSION,
      epoch: 2,
      refs: { cursor: 'c', threadIds: [THREAD], runIds: [RUN] },
    });
  });

  it('accepts an envelope without refs', () => {
    expect(decodeCheckpoint(encodeCheckpoint(0)).refs).toBeUndefined();
  });

  it('rejects a malformed cursor', () => {
    for (const cursor of ['has space', 'path/like', 'x'.repeat(129), '']) {
      expect(
        codeOf(() => encodeCheckpoint(1, { cursor })),
        cursor,
      ).toBe('checkpoint_invalid');
    }
  });

  it('rejects a reference list with the wrong id kind', () => {
    expect(codeOf(() => encodeCheckpoint(1, { threadIds: ['psn_x' as ThreadId] }))).toBe(
      'checkpoint_invalid',
    );
    expect(codeOf(() => encodeCheckpoint(1, { runIds: ['thr_x' as RunId] }))).toBe(
      'checkpoint_invalid',
    );
  });

  it('rejects an unsupported refs field', () => {
    expect(codeOf(() => encodeCheckpoint(1, { cursor: 'c', note: 'hi' } as never))).toBe(
      'checkpoint_invalid',
    );
  });

  it('rejects a negative or non-integer epoch', () => {
    expect(codeOf(() => encodeCheckpoint(-1))).toBe('checkpoint_invalid');
    expect(codeOf(() => encodeCheckpoint(1.5))).toBe('checkpoint_invalid');
  });
});

/** Local wrapper: the checkpoint tests do not need the transaction handle. */
function withWriteGuard<T>(store: Store, fn: () => T): T {
  return withWrite(store, () => fn());
}
