import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPragmas } from '../src/db/pragmas.js';
import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { openStore } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

describe('openStore', () => {
  it('creates the database file and any missing parent directory', () => {
    const dir = tempDir();
    const file = join(dir, 'nested', 'deeper', 'soul.db');

    const store = openStore({ file });
    try {
      expect(existsSync(file)).toBe(true);
      expect(store.file).toBe(resolve(file));
      expect(store.isClosed).toBe(false);
    } finally {
      store.close();
    }
  });

  it('applies the required pragmas and proves they took effect', () => {
    const dir = tempDir();
    const store = openStore({ file: dbPathIn(dir) });
    try {
      const pragmas = readPragmas(databaseOf(store));
      expect(pragmas.journalMode.toLowerCase()).toBe('wal');
      expect(pragmas.foreignKeys).toBe(1);
      expect(pragmas.secureDelete).toBe(1);
      expect(pragmas.busyTimeoutMs).toBe(5_000);
    } finally {
      store.close();
    }
  });

  it('honours a custom busy timeout', () => {
    const dir = tempDir();
    const store = openStore({ file: dbPathIn(dir), busyTimeoutMs: 1_234 });
    try {
      expect(readPragmas(databaseOf(store)).busyTimeoutMs).toBe(1_234);
    } finally {
      store.close();
    }
  });

  it('closes idempotently and refuses further use', () => {
    const dir = tempDir();
    const store = openStore({ file: dbPathIn(dir) });

    store.close();
    expect(store.isClosed).toBe(true);
    expect(() => store.close()).not.toThrow();

    expect(() => databaseOf(store)).toThrow(PersistenceError);
    try {
      databaseOf(store);
    } catch (error) {
      expect((error as PersistenceError).code).toBe('store_closed');
    }
  });

  it('reopens an existing file without losing pragmas', () => {
    const dir = tempDir();
    const file = dbPathIn(dir);

    const first = openStore({ file });
    first.close();

    const second = openStore({ file });
    try {
      expect(second.isClosed).toBe(false);
      expect(readPragmas(databaseOf(second)).journalMode.toLowerCase()).toBe('wal');
    } finally {
      second.close();
    }
  });

  it('fails with store_open_failed when the path is a directory', () => {
    const dir = tempDir();

    try {
      openStore({ file: dir });
      expect.unreachable('opening a directory must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe('store_open_failed');
    }
  });
});
