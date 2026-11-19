/**
 * Atomic conditional writes.
 *
 * Both statements carry their guard in the same SQL statement, so a mismatched
 * expectation writes nothing — proven here by reading the row back from the
 * database rather than trusting the return value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterId, EventId, PersonaId, SourceId } from '@soul-harness/contracts';

import { createRepositories } from '../src/index.js';
import { closeAll, NOW, openMigratedStore } from './helpers/fixture.js';

afterEach(closeAll);

const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';
const PERSONA = `psn_${BODY}0010` as PersonaId;
const EVENT_1 = `evt_${BODY}0010` as EventId;
const EVENT_2 = `evt_${BODY}0020` as EventId;
const EVENT_3 = `evt_${BODY}0030` as EventId;
const ADAPTER = 'qq' as AdapterId;
const SOURCE = 'qq' as SourceId;

function seedPersona(store: ReturnType<typeof openMigratedStore>) {
  const repos = createRepositories(store);
  const persona = repos.personas.insert({
    id: PERSONA,
    displayName: 'Conditional',
    state: 'STARTING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { repos, persona };
}

function insertEvent(
  repos: ReturnType<typeof createRepositories>,
  id: EventId,
  ref: string,
  status: 'received' | 'accepted' | 'acted',
  attentionOutcome: 'not_evaluated' | 'queued' | 'fully_aware' | null,
) {
  return repos.events.insert({
    id,
    personaId: PERSONA,
    source: SOURCE,
    adapterId: ADAPTER,
    adapterEventRef: ref,
    status,
    attentionOutcome,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

describe('personas.compareAndSetState', () => {
  it('B1 applies the change and bumps version by exactly one', () => {
    const store = openMigratedStore();
    const { repos, persona } = seedPersona(store);
    expect(persona.version).toBe(0);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'STARTING',
      expectedVersion: 0,
      nextState: 'STOPPED',
      updatedAt: NOW + 1,
    });

    expect(result).toMatchObject({ id: PERSONA, state: 'STOPPED', version: 1, updatedAt: NOW + 1 });
    // Read back from the database, not from the returned row.
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STOPPED',
      version: 1,
      updatedAt: NOW + 1,
    });
  });

  it('B2 writes nothing when the expected state does not match', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'RUNNING',
      expectedVersion: 0,
      nextState: 'STOPPED',
      updatedAt: NOW + 2,
    });

    expect(result).toBeNull();
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STARTING',
      version: 0,
      updatedAt: NOW,
    });
  });

  it('B3 writes nothing when the expected version does not match', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const result = repos.personas.compareAndSetState({
      id: PERSONA,
      expectedState: 'STARTING',
      expectedVersion: 99,
      nextState: 'STOPPED',
      updatedAt: NOW + 3,
    });

    expect(result).toBeNull();
    expect(repos.personas.getById(PERSONA)).toMatchObject({
      state: 'STARTING',
      version: 0,
      updatedAt: NOW,
    });
  });
});

describe('events.expireIfActive', () => {
  it('B4 expires a received event and leaves attention_outcome alone', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    const event = insertEvent(repos, EVENT_1, 'ref-received', 'received', 'queued');

    const result = repos.events.expireIfActive({ id: EVENT_1, updatedAt: NOW + 10 });

    expect(result).toMatchObject({
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: 'queued',
      updatedAt: NOW + 10,
    });
    const stored = repos.events.getById(EVENT_1);
    expect(stored?.status).toBe('expired');
    expect(stored?.statusReason).toBe('buffer_lost');
    expect(stored?.attentionOutcome).toBe('queued');
    expect(stored?.updatedAt).toBe(NOW + 10);
    expect(stored?.id).toBe(event.id);
  });

  it('B5 expires an accepted event', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);
    insertEvent(repos, EVENT_2, 'ref-accepted', 'accepted', null);

    const result = repos.events.expireIfActive({ id: EVENT_2, updatedAt: NOW + 20 });

    expect(result?.status).toBe('expired');
    const stored = repos.events.getById(EVENT_2);
    expect(stored).toMatchObject({
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: null,
      updatedAt: NOW + 20,
    });
  });

  it('B6 never rewrites a terminal row, and preserves every other field', () => {
    const store = openMigratedStore();
    const { repos } = seedPersona(store);

    const acted = insertEvent(repos, EVENT_1, 'ref-acted', 'acted', 'fully_aware');

    insertEvent(repos, EVENT_2, 'ref-rejected', 'received', null);
    const rejected = repos.events.updateStatus({
      id: EVENT_2,
      status: 'rejected',
      statusReason: 'auth_failed',
      attentionOutcome: null,
      updatedAt: NOW + 5,
    });

    insertEvent(repos, EVENT_3, 'ref-expired', 'received', null);
    const expired = repos.events.updateStatus({
      id: EVENT_3,
      status: 'expired',
      statusReason: 'buffer_lost',
      attentionOutcome: null,
      updatedAt: NOW + 6,
    });

    for (const row of [acted, rejected, expired]) {
      expect(row).not.toBeNull();
      const before = row as NonNullable<typeof row>;

      expect(repos.events.expireIfActive({ id: before.id, updatedAt: NOW + 999 })).toBeNull();

      const after = repos.events.getById(before.id);
      expect(after?.status).toBe(before.status);
      expect(after?.statusReason).toBe(before.statusReason);
      expect(after?.attentionOutcome).toBe(before.attentionOutcome);
      expect(after?.updatedAt).toBe(before.updatedAt);
      expect(after?.salience).toBe(before.salience);
      expect(after?.archiveState).toBe(before.archiveState);
    }
  });
});

describe('conditional update SQL contract', () => {
  function normalize(path: string): string {
    return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
  }

  it('D2 keeps both guards inside the UPDATE statement', () => {
    const personas = normalize(
      join(import.meta.dirname, '..', 'src', 'repositories', 'personas.ts'),
    );
    const events = normalize(join(import.meta.dirname, '..', 'src', 'repositories', 'events.ts'));

    expect(personas).toContain('version = version + 1');
    expect(personas).toContain('WHERE id = ? AND state = ? AND version = ?');

    expect(events).toContain("SET status = 'expired', status_reason = 'buffer_lost'");
    expect(events).toContain("WHERE id = ? AND status IN ('received', 'accepted')");
  });
});
