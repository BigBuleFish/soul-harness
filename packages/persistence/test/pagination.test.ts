/**
 * Keyset pagination: completeness, boundaries, and WAL snapshot behaviour.
 *
 * The snapshot cases (A5/A6) use **two real connections on the same file**:
 *
 *   1. open the read scope (`withRead` → `BEGIN DEFERRED`, no snapshot yet);
 *   2. fetch the first page — *this* SELECT establishes the snapshot;
 *   3. let the other connection commit an insert / delete;
 *   4. continue paging on the original connection.
 *
 * A later fresh snapshot proves the other connection's change really committed,
 * so "not visible" can never be explained by a failed write.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PersonaId } from '@soul-harness/contracts';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { createPersonaRepository } from '../src/repositories/personas.js';
import { createRepositories, migrate, openStore, withRead, type Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;
const BODY = '01JQ8Z3K5M7P9R2T4V6X8Z';

/** 22-char body + 4-digit suffix = the 26 chars a persona id requires. */
function pid(n: number): PersonaId {
  return `psn_${BODY}${String(n).padStart(4, '0')}` as PersonaId;
}

/** 12 ids, ten apart, so an insert can land exactly between two pages. */
const IDS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].map(pid);
const INSERTED = pid(45);
const DELETED = pid(90);

interface Pair {
  readonly dir: string;
  readonly a: Store;
  readonly b: Store;
}

const pairs: Pair[] = [];

function openPair(): Pair {
  const dir = makeTempDir('sh-page-');
  const a = openStore({ file: dbPathIn(dir) });
  migrate(a);
  // A second connection on the same file, exactly what recovery tooling uses.
  const b = openStore({ file: dbPathIn(dir) });
  const pair = { dir, a, b };
  pairs.push(pair);
  return pair;
}

afterEach(() => {
  while (pairs.length > 0) {
    const pair = pairs.pop() as Pair;
    pair.b.close();
    pair.a.close();
    removeTempDir(pair.dir);
  }
});

function seed(store: Store, ids: readonly PersonaId[] = IDS): void {
  const { personas } = createRepositories(store);
  for (const id of ids) {
    personas.insert({
      id,
      displayName: `persona-${id.slice(-4)}`,
      state: 'STOPPED',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function idsOf(rows: readonly { readonly id: PersonaId }[]): PersonaId[] {
  return rows.map((row) => row.id);
}

describe('personas.listPage', () => {
  it('A1 returns every row in id order when the table fits in one page', () => {
    const { a } = openPair();
    seed(a);

    const rows = createRepositories(a).personas.listPage({ limit: 50 });

    expect(idsOf(rows)).toStrictEqual(IDS);
    // Fewer rows than the limit is the end-of-scan signal.
    expect(rows.length).toBeLessThan(50);
  });

  it('A2 stops after a full page by returning an empty page', () => {
    const { a } = openPair();
    seed(a);
    const { personas } = createRepositories(a);

    const first = personas.listPage({ limit: IDS.length });
    expect(first).toHaveLength(IDS.length);
    expect(idsOf(first)).toStrictEqual(IDS);

    const second = personas.listPage({
      afterId: IDS[IDS.length - 1] as PersonaId,
      limit: IDS.length,
    });
    expect(second).toStrictEqual([]);
  });

  it('A3 pages across three pages without skipping or repeating', () => {
    const { a } = openPair();
    seed(a);
    const { personas } = createRepositories(a);

    const seen: PersonaId[] = [];
    let cursor: PersonaId | undefined;

    for (;;) {
      const page = personas.listPage(
        cursor === undefined ? { limit: 4 } : { afterId: cursor, limit: 4 },
      );
      if (page.length === 0) {
        break;
      }
      seen.push(...idsOf(page));
      expect(page.length).toBeLessThanOrEqual(4);
      cursor = page[page.length - 1]?.id;
      if (page.length < 4) {
        break;
      }
    }

    expect(seen).toStrictEqual(IDS);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('A4 returns an empty page for an empty table', () => {
    const { a } = openPair();

    expect(createRepositories(a).personas.listPage({ limit: 10 })).toStrictEqual([]);
  });

  it('A5 keeps the snapshot when another connection inserts between pages', () => {
    const pair = openPair();
    seed(pair.a);
    const reader = createRepositories(pair.a).personas;
    const writer = createRepositories(pair.b).personas;
    const collected: PersonaId[] = [];

    withRead(pair.a, () => {
      // 1. First page: this SELECT is what establishes the snapshot.
      const page1 = reader.listPage({ limit: 4 });
      expect(idsOf(page1)).toStrictEqual(IDS.slice(0, 4));

      // 2. Another connection commits a row that sorts between page 1 and page 2.
      writer.insert({
        id: INSERTED,
        displayName: 'inserted-between-pages',
        state: 'STOPPED',
        createdAt: NOW,
        updatedAt: NOW,
      });

      // 3. Page 2 must start at 0050, not at the newly inserted 0045.
      const page2 = reader.listPage({
        afterId: page1[page1.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page2)).toStrictEqual(IDS.slice(4, 8));

      const page3 = reader.listPage({
        afterId: page2[page2.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page3)).toStrictEqual(IDS.slice(8, 12));

      const page4 = reader.listPage({
        afterId: page3[page3.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(page4).toStrictEqual([]);

      collected.push(...idsOf(page1), ...idsOf(page2), ...idsOf(page3));
    });

    // The scan saw the snapshot (12 rows), not the state at transaction end (13).
    expect(collected).toStrictEqual(IDS);
    expect(collected).not.toContain(INSERTED);

    // Control: a fresh snapshot does see the insert, so the write really committed.
    const fresh = withRead(pair.a, () => reader.listPage({ limit: 50 }));
    expect(fresh).toHaveLength(IDS.length + 1);
    expect(idsOf(fresh)).toContain(INSERTED);
  });

  it('A6 still returns a row deleted between pages by another connection', () => {
    const pair = openPair();
    seed(pair.a);
    const reader = createRepositories(pair.a).personas;
    const collected: PersonaId[] = [];

    withRead(pair.a, () => {
      const page1 = reader.listPage({ limit: 4 });
      expect(idsOf(page1)).toStrictEqual(IDS.slice(0, 4));

      // Delete a row that has NOT been read yet (it belongs to page 3).
      const removed = databaseOf(pair.b).prepare('DELETE FROM personas WHERE id = ?').run(DELETED);
      expect(Number(removed.changes)).toBe(1);

      const page2 = reader.listPage({
        afterId: page1[page1.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page2)).toStrictEqual(IDS.slice(4, 8));

      // The snapshot still holds the old version of the deleted row.
      const page3 = reader.listPage({
        afterId: page2[page2.length - 1]?.id as PersonaId,
        limit: 4,
      });
      expect(idsOf(page3)).toStrictEqual(IDS.slice(8, 12));
      expect(idsOf(page3)).toContain(DELETED);

      collected.push(...idsOf(page1), ...idsOf(page2), ...idsOf(page3));
    });

    expect(collected).toStrictEqual(IDS);
    expect(collected).toContain(DELETED);

    // Control: the delete committed — a fresh snapshot has 11 rows.
    const fresh = withRead(pair.a, () => reader.listPage({ limit: 50 }));
    expect(fresh).toHaveLength(IDS.length - 1);
    expect(idsOf(fresh)).not.toContain(DELETED);
  });
});

describe('listPage argument validation', () => {
  // Validation must run before any database access: the store below is a bare
  // object, so a query attempt would throw a TypeError instead of the code below.
  const personas = createPersonaRepository({} as unknown as Store);

  function codeOf(run: () => unknown): string {
    try {
      run();
      return 'no-throw';
    } catch (error) {
      return error instanceof PersistenceError ? error.code : 'not-a-persistence-error';
    }
  }

  it('C1 rejects limit 0', () => {
    expect(codeOf(() => personas.listPage({ limit: 0 }))).toBe('invalid_argument');
  });

  it('C2 rejects limit above the hard ceiling', () => {
    expect(codeOf(() => personas.listPage({ limit: 501 }))).toBe('invalid_argument');
  });

  it('C3 rejects a non-integer limit', () => {
    expect(codeOf(() => personas.listPage({ limit: 1.5 }))).toBe('invalid_argument');
  });

  it('C4 rejects an afterId that is not a persona id', () => {
    expect(codeOf(() => personas.listPage({ afterId: '' as PersonaId }))).toBe('invalid_argument');
    expect(codeOf(() => personas.listPage({ afterId: 'not-an-id' as PersonaId }))).toBe(
      'invalid_argument',
    );
  });
});

describe('pagination SQL contract', () => {
  function normalize(path: string): string {
    return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
  }

  it('D1 uses the primary key as both cursor and sort key', () => {
    const personas = normalize(
      join(import.meta.dirname, '..', 'src', 'repositories', 'personas.ts'),
    );
    const events = normalize(join(import.meta.dirname, '..', 'src', 'repositories', 'events.ts'));

    expect(personas).toContain('FROM personas ORDER BY id ASC LIMIT ?');
    expect(personas).toContain('FROM personas WHERE id > ? ORDER BY id ASC LIMIT ?');

    expect(events).toContain('WHERE persona_id = ? AND status = ? ORDER BY id ASC LIMIT ?');
    expect(events).toContain(
      'WHERE persona_id = ? AND status = ? AND id > ? ORDER BY id ASC LIMIT ?',
    );

    // Timestamps are not unique; they must never be used as a cursor.
    expect(personas).not.toContain('WHERE created_at >');
    expect(events).not.toContain('WHERE received_at >');
  });
});
