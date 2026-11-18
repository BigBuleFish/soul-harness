/**
 * Stale-lock takeover race, with real independent processes.
 *
 * The stale lock is not hand-written: a real process takes the lock and is then
 * killed with SIGKILL, which is exactly how a stale lock appears in production.
 * Every round then starts N contenders that wait on a file barrier and call the
 * real `acquireInstanceLock` at the same instant, so they genuinely compete
 * rather than being simulated in sequence.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE_NAME } from '../src/lock.js';
import { buildDaemonApp, makeTempDir, removeTempDir } from './helpers/harness.js';

const LOCK_CONTENDER = join(import.meta.dirname, 'fixtures', 'lock-contender.mjs');

interface ContenderResult {
  readonly ok: boolean;
  readonly token?: string;
  readonly code?: string;
  readonly pid?: number;
}

const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop() as ChildProcess;
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
});

beforeAll(() => {
  buildDaemonApp();
}, 60_000);

function runContender(dataDir: string): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [LOCK_CONTENDER, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);

  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });

  return { child, output: () => output };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Produces a genuinely stale lock: a real holder, then SIGKILL. */
async function createStaleLock(dataDir: string): Promise<string> {
  const seed = runContender(dataDir);
  writeFileSync(join(dataDir, 'go'), 'go');

  await waitFor(
    () => seed.output().includes('"ok":true'),
    15_000,
    'the seed holder to acquire the lock',
  );
  seed.child.kill('SIGKILL');
  await new Promise<void>((resolve) => seed.child.once('close', () => resolve()));

  const lockPath = join(dataDir, LOCK_FILE_NAME);
  expect(existsSync(lockPath)).toBe(true);
  return readFileSync(lockPath, 'utf8');
}

describe('stale-lock takeover race', { timeout: 120_000 }, () => {
  it('lets at most one of several real processes win, repeatedly', async () => {
    const rounds = 5;
    const contenders = 4;

    for (let round = 0; round < rounds; round += 1) {
      const dataDir = makeTempDir('sh-race-');
      try {
        const staleBytes = await createStaleLock(dataDir);

        const participants = Array.from({ length: contenders }, () => runContender(dataDir));

        // Real barrier: everyone reports ready, then the parent opens the gate.
        await waitFor(
          () =>
            participants.every((participant) =>
              existsSync(join(dataDir, `ready-${participant.child.pid}`)),
            ),
          15_000,
          `all ${contenders} contenders to be ready (round ${round})`,
        );
        writeFileSync(join(dataDir, 'go'), 'go');

        await waitFor(
          () => participants.every((participant) => participant.output().includes('"ok"')),
          15_000,
          `all contenders to report (round ${round})`,
        );

        const results = participants.map(
          (participant) =>
            JSON.parse(participant.output().trim().split('\n')[0] ?? '{}') as ContenderResult,
        );

        const winners = results.filter((result) => result.ok);
        expect(winners, `round ${round}: exactly one winner`).toHaveLength(1);

        for (const loser of results.filter((result) => !result.ok)) {
          expect(['lock_held', 'lock_acquire_failed']).toContain(loser.code);
        }

        // The winner's lock is intact and still the one on disk.
        const onDisk = JSON.parse(readFileSync(join(dataDir, LOCK_FILE_NAME), 'utf8')) as {
          bootToken?: string;
        };
        expect(onDisk.bootToken).toBe(winners[0]?.token);
        expect(onDisk.bootToken).not.toBe(
          (JSON.parse(staleBytes) as { bootToken?: string }).bootToken,
        );

        // Losers exited without touching the winner's lock.
        for (const participant of participants) {
          if (participant.child.exitCode === null) {
            participant.child.kill('SIGKILL');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        const after = JSON.parse(readFileSync(join(dataDir, LOCK_FILE_NAME), 'utf8')) as {
          bootToken?: string;
        };
        expect(after.bootToken).toBe(winners[0]?.token);
      } finally {
        removeTempDir(dataDir);
      }
    }
  });

  it('the winner keeps the lock: a later contender is refused', async () => {
    const dataDir = makeTempDir('sh-race-hold-');
    try {
      await createStaleLock(dataDir);

      const first = runContender(dataDir);
      writeFileSync(join(dataDir, 'go'), 'go');
      await waitFor(
        () => first.output().includes('"ok":true'),
        15_000,
        'the first contender to win',
      );
      const winner = JSON.parse(first.output().trim()) as ContenderResult;

      const second = runContender(dataDir);
      // The barrier file already exists, so this contender starts immediately.
      await waitFor(
        () => second.output().includes('"ok"'),
        15_000,
        'the second contender to report',
      );
      const result = JSON.parse(second.output().trim()) as ContenderResult;

      expect(result.ok).toBe(false);
      expect(result.code).toBe('lock_held');

      const onDisk = JSON.parse(readFileSync(join(dataDir, LOCK_FILE_NAME), 'utf8')) as {
        bootToken?: string;
      };
      expect(onDisk.bootToken).toBe(winner.token);
    } finally {
      removeTempDir(dataDir);
    }
  });
});
