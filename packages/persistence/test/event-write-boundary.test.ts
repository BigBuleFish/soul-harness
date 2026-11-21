/**
 * Event write boundary (C2).
 *
 * Production creates events only through `commitP1Envelope()` and closes them
 * only through the four P1 terminal transitions. The generic `insert()` and
 * `updateStatus()` entry points are gone, so no production path can set
 * `acted`, `noticed`, `understood` or `response_committed`.
 *
 * The negative cases keep every other guard satisfied (same persona, active
 * status) so a miss can only come from the guard under test.
 */

import type { AdapterId, EventId, EventStatus, PersonaId, SourceId } from '@soul-harness/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import * as persistence from '../src/index.js';
import {
  createRepositories,
  isPersistenceError,
  migrate,
  openStore,
  type Store,
} from '../src/index.js';
import { seedEvent } from './helpers/event-seed.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;
const BODY = '000000000000000000000000';
const PERSONA = `psn_${BODY}01` as PersonaId;
const OTHER = `psn_${BODY}02` as PersonaId;
const EVENT = `evt_${BODY}01` as EventId;
const ADAPTER = 'mc' as AdapterId;
const SOURCE = 'mc.chat' as SourceId;

const fixtures: Array<{ dir: string; store: Store }> = [];

function openFixture(): Store {
  const dir = makeTempDir('sh-evt-boundary-');
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

function seedPersonas(store: Store): void {
  for (const [id, name] of [
    [PERSONA, 'P'],
    [OTHER, 'O'],
  ] as const) {
    repos(store).personas.insert({
      id,
      displayName: name,
      state: 'RUNNING',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function commit(store: Store, id: EventId = EVENT, personaId: PersonaId = PERSONA) {
  return repos(store).events.commitP1Envelope({
    id,
    personaId,
    source: SOURCE,
    adapterId: ADAPTER,
    adapterEventRef: `ref-${id}`,
    receivedAt: NOW,
    updatedAt: NOW,
    outcome: { status: 'accepted' },
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return isPersistenceError(error) ? error.code : 'not-a-persistence-error';
  }
}

function eventRow(store: Store, id: EventId = EVENT, personaId: PersonaId = PERSONA) {
  return repos(store).events.getById({ personaId, id });
}

describe('event repository surface', () => {
  it('no longer exposes insert() or updateStatus()', () => {
    const store = openFixture();

    expect('insert' in repos(store).events).toBe(false);
    expect('updateStatus' in repos(store).events).toBe(false);
  });

  it('does not export the test-only seed helper from the package entry', () => {
    expect('seedEvent' in persistence).toBe(false);
  });

  it('commitP1Envelope is the only production creation path and writes accepted', () => {
    const store = openFixture();
    seedPersonas(store);

    const row = commit(store);

    expect(row).toMatchObject({
      status: 'accepted',
      statusReason: null,
      attentionOutcome: null,
      archiveState: 'none',
    });
  });

  it('commitP1Envelope still supports expired/queue_overflow', () => {
    const store = openFixture();
    seedPersonas(store);

    const row = repos(store).events.commitP1Envelope({
      id: EVENT,
      personaId: PERSONA,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: 'ref-overflow',
      receivedAt: NOW,
      updatedAt: NOW,
      outcome: { status: 'expired', reason: 'queue_overflow' },
    });

    expect(row).toMatchObject({ status: 'expired', statusReason: 'queue_overflow' });
  });

  it('commitP1Envelope rejects any other outcome', () => {
    const store = openFixture();
    seedPersonas(store);

    for (const outcome of [
      { status: 'noticed' },
      { status: 'acted' },
      { status: 'rejected' },
      { status: 'expired', reason: 'ttl_expired' },
    ]) {
      expect(
        codeOf(() =>
          repos(store).events.commitP1Envelope({
            id: EVENT,
            personaId: PERSONA,
            source: SOURCE,
            adapterId: ADAPTER,
            adapterEventRef: 'ref-bad',
            receivedAt: NOW,
            updatedAt: NOW,
            outcome: outcome as never,
          }),
        ),
      ).toBe('invalid_argument');
    }
    expect(eventRow(store)).toBeNull();
  });
});

describe('P1 terminal transitions keep their original-status guards', () => {
  function seedActive(store: Store, status: 'received' | 'accepted'): void {
    seedEvent(store, {
      id: EVENT,
      personaId: PERSONA,
      status,
      source: SOURCE,
      adapterId: ADAPTER,
      adapterEventRef: `ref-${status}`,
      receivedAt: NOW,
      updatedAt: NOW,
    });
  }

  it('expireIfActive only accepts received / accepted', () => {
    for (const status of ['received', 'accepted'] as const) {
      const store = openFixture();
      seedPersonas(store);
      seedActive(store, status);

      expect(
        repos(store).events.expireIfActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 1,
        }),
      ).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
    }

    for (const status of ['rejected', 'expired'] as const) {
      const store = openFixture();
      seedPersonas(store);
      seedEvent(store, {
        id: EVENT,
        personaId: PERSONA,
        status,
        statusReason: status === 'rejected' ? 'auth_failed' : 'ttl_expired',
        source: SOURCE,
        adapterId: ADAPTER,
        adapterEventRef: `ref-${status}`,
        receivedAt: NOW,
        updatedAt: NOW,
      });
      const before = eventRow(store);

      expect(
        repos(store).events.expireIfActive({ id: EVENT, personaId: PERSONA, updatedAt: NOW + 1 }),
      ).toBeNull();
      expect(eventRow(store)).toStrictEqual(before);
    }
  });

  it('expireActive and rejectIfActive only accept received / accepted', () => {
    for (const status of ['rejected', 'expired'] as const) {
      const store = openFixture();
      seedPersonas(store);
      seedEvent(store, {
        id: EVENT,
        personaId: PERSONA,
        status,
        statusReason: status === 'rejected' ? 'auth_failed' : 'ttl_expired',
        source: SOURCE,
        adapterId: ADAPTER,
        adapterEventRef: `ref-${status}`,
        receivedAt: NOW,
        updatedAt: NOW,
      });
      const before = eventRow(store);

      expect(
        repos(store).events.expireActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 2,
          reason: 'ttl_expired',
        }),
      ).toBeNull();
      expect(
        repos(store).events.rejectIfActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 3,
          reason: 'processing_failed',
        }),
      ).toBeNull();
      expect(eventRow(store)).toStrictEqual(before);
    }
  });

  it('a CAS miss returns null and leaves the row byte-identical', () => {
    const store = openFixture();
    seedPersonas(store);
    seedActive(store, 'received');
    const before = eventRow(store);

    // Wrong persona: same active status, so only the scope can explain the miss.
    expect(
      repos(store).events.expireIfActive({ id: EVENT, personaId: OTHER, updatedAt: NOW + 4 }),
    ).toBeNull();
    expect(
      repos(store).events.expireActive({
        id: EVENT,
        personaId: OTHER,
        updatedAt: NOW + 4,
        reason: 'ttl_expired',
      }),
    ).toBeNull();
    expect(
      repos(store).events.rejectIfActive({
        id: EVENT,
        personaId: OTHER,
        updatedAt: NOW + 4,
        reason: 'processing_failed',
      }),
    ).toBeNull();
    expect(eventRow(store)).toStrictEqual(before);
  });
});

describe('no production write path can reach acted or the cognition chain', () => {
  const UNREACHABLE: readonly EventStatus[] = [
    'acted',
    'noticed',
    'understood',
    'response_committed',
  ];

  it.each(UNREACHABLE)(
    'every dedicated method refuses a %s row and leaves it unchanged',
    (status) => {
      const store = openFixture();
      seedPersonas(store);
      seedEvent(store, {
        id: EVENT,
        personaId: PERSONA,
        status,
        source: SOURCE,
        adapterId: ADAPTER,
        adapterEventRef: 'ref-unreachable',
        receivedAt: NOW,
        updatedAt: NOW,
      });
      const before = eventRow(store);

      expect(
        repos(store).events.expireIfActive({ id: EVENT, personaId: PERSONA, updatedAt: NOW + 5 }),
      ).toBeNull();
      expect(
        repos(store).events.expireActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 5,
          reason: 'ttl_expired',
        }),
      ).toBeNull();
      expect(
        repos(store).events.rejectIfActive({
          id: EVENT,
          personaId: PERSONA,
          updatedAt: NOW + 5,
          reason: 'processing_failed',
        }),
      ).toBeNull();
      expect(eventRow(store)).toStrictEqual(before);
    },
  );

  it('every transition that succeeds writes only expired or rejected', () => {
    const outcomes: EventStatus[] = [];
    for (const method of ['expireIfActive', 'expireActive', 'rejectIfActive'] as const) {
      const store = openFixture();
      seedPersonas(store);
      commit(store);

      const row =
        method === 'expireIfActive'
          ? repos(store).events.expireIfActive({
              id: EVENT,
              personaId: PERSONA,
              updatedAt: NOW + 6,
            })
          : method === 'expireActive'
            ? repos(store).events.expireActive({
                id: EVENT,
                personaId: PERSONA,
                updatedAt: NOW + 6,
                reason: 'ttl_expired',
              })
            : repos(store).events.rejectIfActive({
                id: EVENT,
                personaId: PERSONA,
                updatedAt: NOW + 6,
                reason: 'processing_failed',
              });
      if (row !== null) {
        outcomes.push(row.status);
      }
    }

    expect(outcomes).toStrictEqual(['expired', 'expired', 'rejected']);
  });
});
