import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { migrate, openStore, verifySchema } from '../src/index.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

const NOW = 1_731_700_000_000;
const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';

describe('reopening a database that already holds data', () => {
  it('keeps rows, migration state and schema after a real close/reopen', () => {
    const dir = tempDir();
    const file = dbPathIn(dir);

    const first = openStore({ file });
    migrate(first);
    databaseOf(first)
      .prepare(
        'INSERT INTO personas (id, display_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(PERSONA, 'Primary', 'RUNNING', NOW, NOW);
    first.close();

    const second = openStore({ file });
    stores.push(second);

    expect(migrate(second).applied).toStrictEqual([]);
    expect(() => verifySchema(second)).not.toThrow();

    const row = databaseOf(second)
      .prepare('SELECT id, display_name, state, version, epoch FROM personas')
      .get() as { id: string; display_name: string; state: string; version: number; epoch: number };

    expect(row.id).toBe(PERSONA);
    expect(row.display_name).toBe('Primary');
    expect(row.state).toBe('RUNNING');
    expect(row.version).toBe(0);
    expect(row.epoch).toBe(1);
  });

  it('survives two close/reopen cycles without duplicating history', () => {
    const dir = tempDir();
    const file = dbPathIn(dir);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const store = openStore({ file });
      const result = migrate(store);
      if (cycle === 0) {
        expect(result.applied).toStrictEqual([1]);
      } else {
        expect(result.applied).toStrictEqual([]);
      }
      store.close();
    }

    const final = openStore({ file });
    stores.push(final);
    const count = databaseOf(final)
      .prepare('SELECT count(*) AS n FROM schema_migrations')
      .get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
