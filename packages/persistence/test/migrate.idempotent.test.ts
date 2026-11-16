import { afterEach, describe, expect, it } from 'vitest';

import { databaseOf } from '../src/db/store.js';
import { migrate, openStore, verifySchema } from '../src/index.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const dirs: string[] = [];
const stores: Store[] = [];

function freshStore(): Store {
  const dir = makeTempDir();
  dirs.push(dir);
  const store = openStore({ file: dbPathIn(dir) });
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

describe('restarting against an already migrated database', () => {
  it('does not execute anything twice', () => {
    const store = freshStore();

    const first = migrate(store);
    expect(first.applied).toStrictEqual([1]);

    const second = migrate(store);
    expect(second.applied).toStrictEqual([]);
    expect(second.alreadyApplied).toStrictEqual([1]);
    expect(second.currentVersion).toBe(1);

    const third = migrate(store);
    expect(third.applied).toStrictEqual([]);

    const count = databaseOf(store)
      .prepare('SELECT count(*) AS n FROM schema_migrations')
      .get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it('keeps an existing database healthy across a real close/reopen cycle', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const file = dbPathIn(dir);

    const first = openStore({ file });
    migrate(first);
    first.close();

    const second = openStore({ file });
    stores.push(second);

    const result = migrate(second);
    expect(result.applied).toStrictEqual([]);
    expect(result.alreadyApplied).toStrictEqual([1]);
    expect(() => verifySchema(second)).not.toThrow();
  });
});
