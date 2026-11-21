/**
 * Store construction boundary (C3).
 *
 * `openStore()` is the only supported entry point. The class stays exported so
 * consumers can keep using `Store` as a type (and `instanceof`), but its
 * constructor is private in TypeScript **and** guarded at runtime by a
 * module-private token, so a plain JavaScript caller that ignores types still
 * cannot create an uninitialized store.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import * as persistence from '../src/index.js';
import { createRepositories, isPersistenceError, openStore, Store } from '../src/index.js';
import { databaseOf } from '../src/db/store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sh-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5 });
  }
});

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return isPersistenceError(error) ? error.code : 'not-a-persistence-error';
  }
}

/** Closes a handle that may already have been released by the constructor guard. */
function safeClose(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Already closed.
  }
}

describe('openStore is the normal construction path', () => {
  it('creates a Store with an absolute file path and applies every pragma', () => {
    const dir = tempDir();
    const file = join(dir, 'soul.db');
    const store = openStore({ file });

    try {
      expect(store).toBeInstanceOf(Store);
      expect(store.file).toBe(resolve(file));
      expect(store.isClosed).toBe(false);

      const db = databaseOf(store);
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA secure_delete').get()).toMatchObject({ secure_delete: 1 });
      expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    } finally {
      store.close();
    }
  });

  it('resolves a relative path against the working directory', () => {
    const rel = join('.tmp-c3-store', `${process.pid}-${Date.now()}.db`);
    const store = openStore({ file: rel });

    try {
      expect(store.file).toBe(resolve(rel));
    } finally {
      store.close();
      rmSync(resolve('.tmp-c3-store'), { recursive: true, force: true });
    }
  });

  it('close() is idempotent and databaseOf() refuses the closed store', () => {
    const dir = tempDir();
    const store = openStore({ file: join(dir, 'soul.db') });

    expect(codeOf(() => databaseOf(store))).toBe('no-throw');
    store.close();
    expect(store.isClosed).toBe(true);
    expect(codeOf(() => databaseOf(store))).toBe('store_closed');
    expect(() => store.close()).not.toThrow();
    // Repositories over a closed store fail on first use, not silently.
    expect(codeOf(() => createRepositories(store).personas.list())).toBe('store_closed');
  });
});

describe('direct construction is blocked at runtime', () => {
  type ForcedConstructor = new (...args: unknown[]) => Store;
  const ForcedStore = Store as unknown as ForcedConstructor;

  it('rejects a JavaScript caller that bypasses the type checker and releases the handle', () => {
    const dir = tempDir();
    const db = new DatabaseSync(':memory:');
    try {
      expect(codeOf(() => new ForcedStore(join(dir, 'soul.db'), db))).toBe('invalid_argument');
      // The failed construction must not leave an open connection behind: the
      // guard closes the smuggled handle before throwing.
      expect(() => db.prepare('SELECT 1 AS n').get()).toThrowError(/not open/i);
    } finally {
      safeClose(db);
    }
  });

  it('rejects a guessed construction symbol', () => {
    const dir = tempDir();
    const db = new DatabaseSync(':memory:');
    try {
      expect(codeOf(() => new ForcedStore(join(dir, 'soul.db'), db, Symbol('guess')))).toBe(
        'invalid_argument',
      );
    } finally {
      safeClose(db);
    }
  });

  it('does no filesystem or database work before rejecting', () => {
    const dir = tempDir();
    const nested = join(dir, 'missing', 'soul.db');

    expect(codeOf(() => new ForcedStore(nested, {}))).toBe('invalid_argument');
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });

  it('cannot be constructed through a static factory', () => {
    const statics = Object.getOwnPropertyNames(Store).filter(
      (name) => typeof (Store as unknown as Record<string, unknown>)[name] === 'function',
    );
    expect(statics).toStrictEqual([]);
  });

  it('an Object.create pseudo-store is unusable', () => {
    const pseudo = Object.create(Store.prototype) as Store;

    expect(codeOf(() => databaseOf(pseudo))).toBe('store_closed');
    expect(codeOf(() => createRepositories(pseudo).personas.list())).toBe('store_closed');
  });

  it('the constructor is private in the TypeScript declarations', () => {
    const dir = tempDir();
    const attempt = () => {
      // Three full arguments: if the constructor ever becomes public, the only
      // remaining error would be the argument count, so supplying every
      // parameter (the third as `never`) makes this expect-error prove privacy.
      // @ts-expect-error Store's constructor is private; only openStore() may build one.
      return new Store(join(dir, 'soul.db'), {} as DatabaseSync, undefined as never);
    };

    expect(codeOf(attempt)).toBe('invalid_argument');
  });
});

describe('the package entry keeps the type but not the construction capability', () => {
  it('exports Store but neither the internal factory nor databaseOf', () => {
    expect('Store' in persistence).toBe(true);
    expect(typeof persistence.Store).toBe('function');
    expect('createStore' in persistence).toBe(false);
    expect('databaseOf' in persistence).toBe(false);
  });

  it('never widens the public constructor surface through prototypes', () => {
    expect(Object.getPrototypeOf(Store.prototype)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(Store.prototype).sort()).toStrictEqual([
      'close',
      'constructor',
      'isClosed',
    ]);
  });
});
