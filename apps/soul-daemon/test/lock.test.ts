import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it('refuses to take over while another process claims the same stale snapshot', async () => {
    const dir = tempDir();
    const pid = await deadPid();
    const path = join(dir, LOCK_FILE_NAME);
    const stale = JSON.stringify({ pid, bootToken: 'dead', startedAt: 'now', dataDir: dir });
    writeFileSync(path, stale);

    // The claim name is derived from the snapshot bytes, so a contender that saw
    // the same stale lock competes for this exact file.
    const claimPath = `${path}.claim.${createHash('sha256').update(stale, 'utf8').digest('hex').slice(0, 16)}`;
    writeFileSync(claimPath, JSON.stringify({ pid: 1, bootToken: 'other', startedAt: 'now' }));

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_acquire_failed');

    // Neither file was touched: the claim belongs to the other process.
    expect(readFileSync(path, 'utf8')).toBe(stale);
    expect(existsSync(claimPath)).toBe(true);
  });

  it('never deletes a lock that changed since it was inspected', async () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE_NAME);
    const sleeper = spawnSleeper();
    children.push(sleeper);
    const livePid = sleeper.pid as number;

    // A stale snapshot that the implementation would normally take over …
    const dead = await deadPid();
    writeFileSync(
      path,
      JSON.stringify({ pid: dead, bootToken: 'dead', startedAt: 'now', dataDir: dir }),
    );

    // … but by the time the claim is verified the file holds a live lock. The
    // simulated swap happens through the injectable liveness probe: the first
    // check sees a dead pid, then the file is replaced by a live one.
    const replaced = JSON.stringify({
      pid: livePid,
      bootToken: 'live',
      startedAt: 'now',
      dataDir: dir,
    });
    let checks = 0;
    expect(
      codeOf(() =>
        acquireInstanceLock(dir, {
          isAlive: () => {
            checks += 1;
            if (checks === 1) {
              // Observation says "dead"; swap in a live lock before verification.
              writeFileSync(path, replaced);
              return false;
            }
            return false;
          },
        }),
      ),
    ).toBe('lock_held');

    expect(readFileSync(path, 'utf8')).toBe(replaced);
  });
});

describe('invalid lock payloads are rejected, never taken over', () => {
  const invalidPids: ReadonlyArray<{ label: string; pid: unknown }> = [
    { label: 'zero', pid: 0 },
    { label: 'negative', pid: -1 },
    { label: 'fractional', pid: 1.5 },
    { label: 'above the safe integer range', pid: 9_007_199_254_740_992 },
    { label: 'a string', pid: '123' },
    { label: 'null', pid: null },
  ];

  it.each(invalidPids)('rejects a lock whose pid is $label and keeps the file', ({ pid }) => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE_NAME);
    const content = JSON.stringify({ pid, bootToken: 'bad', startedAt: 'now', dataDir: dir });
    writeFileSync(path, content);

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_unreadable');

    // Untrusted data is never renamed or deleted.
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('leaves no claim file behind when rejecting', () => {
    const dir = tempDir();
    const path = join(dir, LOCK_FILE_NAME);
    writeFileSync(
      path,
      JSON.stringify({ pid: 0, bootToken: 'bad', startedAt: 'now', dataDir: dir }),
    );

    expect(codeOf(() => acquireInstanceLock(dir))).toBe('lock_unreadable');

    const leftovers = readdirSync(dir).filter((entry) => entry.includes('.claim.'));
    expect(leftovers).toStrictEqual([]);
  });

  it('still takes over a valid dead pid and still refuses a valid live pid', async () => {
    const deadDir = tempDir();
    const dead = await deadPid();
    writeFileSync(
      join(deadDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: dead, bootToken: 'dead', startedAt: 'now', dataDir: deadDir }),
    );
    const lock = acquireInstanceLock(deadDir);
    expect(lock.holder.pid).toBe(process.pid);
    lock.release();

    const liveDir = tempDir();
    const sleeper = spawnSleeper();
    children.push(sleeper);
    writeFileSync(
      join(liveDir, LOCK_FILE_NAME),
      JSON.stringify({ pid: sleeper.pid, bootToken: 'live', startedAt: 'now', dataDir: liveDir }),
    );
    expect(codeOf(() => acquireInstanceLock(liveDir))).toBe('lock_held');
  });
});
