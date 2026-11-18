import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { LOCK_FILE_NAME, acquireInstanceLock } from '../src/lock.js';
import { isDaemonError } from '../src/errors.js';
import { deadPid, makeTempDir, removeTempDir, spawnSleeper } from './helpers/harness.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length > 0) {
    (children.pop() as ChildProcess).kill('SIGKILL');
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-lock-');
  dirs.push(dir);
  return dir;
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isDaemonError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('instance lock', () => {
  it('creates a lock file describing the holder', () => {
    const dir = tempDir();
    const lock = acquireInstanceLock(dir);

    expect(lock.path).toBe(join(dir, LOCK_FILE_NAME));
    const written = JSON.parse(readFileSync(lock.path, 'utf8')) as Record<string, unknown>;
    expect(written['pid']).toBe(process.pid);
    expect(written['bootToken']).toBe(lock.holder.bootToken);
    expect(written['dataDir']).toBe(dir);

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('refuses a second lock on the same data directory', () => {
    const dir = tempDir();
    const first = acquireInstanceLock(dir);

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_held');

    // The holder's lock is untouched by the loser.
    const stillThere = JSON.parse(readFileSync(first.path, 'utf8')) as Record<string, unknown>;
    expect(stillThere['bootToken']).toBe(first.holder.bootToken);

    first.release();
  });

  it('allows different data directories independently', () => {
    const a = acquireInstanceLock(tempDir());
    const b = acquireInstanceLock(tempDir());

    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);

    a.release();
    b.release();
  });

  it('release is idempotent and owner-checked', () => {
    const dir = tempDir();
    const lock = acquireInstanceLock(dir);

    lock.release();
    expect(() => lock.release()).not.toThrow();

    const second = acquireInstanceLock(dir);
    // Someone else's lock must never be deleted by a stale owner.
    writeFileSync(
      second.path,
      JSON.stringify({
        pid: process.pid,
        bootToken: 'someone-else',
        startedAt: 'now',
        dataDir: dir,
      }),
    );
    expect(codeOf(() => second.release())).toBe('lock_release_failed');
    expect(existsSync(second.path)).toBe(true);

    writeFileSync(
      second.path,
      JSON.stringify({ pid: process.pid, bootToken: 'x', startedAt: 'now', dataDir: dir }),
    );
    second.release();
  });

  it('refuses a corrupted lock file instead of deleting it', () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE_NAME);
    writeFileSync(path, 'not-json');

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_unreadable');
    expect(readFileSync(path, 'utf8')).toBe('not-json');
  });

  it('refuses a lock whose holder is alive (foreign live pid)', async () => {
    const dir = tempDir();
    const sleeper = spawnSleeper();
    children.push(sleeper);
    const pid = sleeper.pid as number;

    const path = join(dir, LOCK_FILE_NAME);
    writeFileSync(path, JSON.stringify({ pid, bootToken: 'live', startedAt: 'now', dataDir: dir }));

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_held');
    expect(existsSync(path)).toBe(true);
  });

  it('takes over a lock whose holder is provably dead', async () => {
    const dir = tempDir();
    const pid = await deadPid();
    const path = join(dir, LOCK_FILE_NAME);
    writeFileSync(path, JSON.stringify({ pid, bootToken: 'dead', startedAt: 'now', dataDir: dir }));

    const lock = acquireInstanceLock(dir);
    expect(lock.holder.pid).toBe(process.pid);
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(written['bootToken']).toBe(lock.holder.bootToken);

    lock.release();
  });

  it('only one contender can claim a stale lock', async () => {
    const dir = tempDir();
    const pid = await deadPid();
    const path = join(dir, LOCK_FILE_NAME);
    writeFileSync(path, JSON.stringify({ pid, bootToken: 'dead', startedAt: 'now', dataDir: dir }));

    // Simulate the loser: another process already renamed the stale file away.
    const { renameSync } = await import('node:fs');
    renameSync(path, `${path}.stale-other`);

    const lock = acquireInstanceLock(dir);
    expect(existsSync(path)).toBe(true);
    lock.release();
  });
});
