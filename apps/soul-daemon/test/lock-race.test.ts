/**
 * Stale-lock takeover race, with real independent processes.
 *
 * The stale lock is not hand-written: a real process takes the lock and is then
 * killed with SIGKILL, which is exactly how a stale lock appears in production.
 *
 * The barrier is **per phase**. The seed holder waits for `gate-seed`; the racers
 * wait for `gate-race`. Sharing one gate would let a racer slip through while the
 * seed phase was still using it, and the "everyone started together" claim would
 * be unprovable.
 *
 * Before opening `gate-race` the test asserts that no racer has produced any
 * output and that the stale lock bytes are untouched — i.e. nobody has called
 * `acquireInstanceLock` yet.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE_NAME } from '../src/lock.js';
import { buildDaemonApp, makeTempDir, removeTempDir } from './helpers/harness.js';

const LOCK_CONTENDER = join(import.meta.dirname, 'fixtures', 'lock-contender.mjs');

/** One gate per phase: the seed holder and the racers never share a file. */
const SEED_GATE = 'gate-seed';
const RACE_GATE = 'gate-race';

interface ContenderResult {
  readonly ok: boolean;
  readonly token?: string;
  readonly code?: string;
  readonly pid?: number;
}

interface Contender {
  readonly child: ChildProcess;
  readonly readyPath: string;
  output(): string;
}

const children: ChildProcess[] = [];

function killAll(): void {
  while (children.length > 0) {
    const child = children.pop() as ChildProcess;
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
}

afterEach(() => {
  killAll();
});

beforeAll(() => {
  buildDaemonApp();
}, 60_000);

function runContender(dataDir: string, gate: string): Contender {
  const child = spawn(process.execPath, [LOCK_CONTENDER, dataDir, gate], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);

  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });

  return { child, readyPath: join(dataDir, `ready-${gate}-${child.pid}`), output: () => output };
}

function stopContender(contender: Contender): void {
  if (contender.child.exitCode === null) {
    contender.child.kill('SIGKILL');
  }
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
  const seed = runContender(dataDir, SEED_GATE);

  await waitFor(() => existsSync(seed.readyPath), 15_000, 'the seed holder to be ready');
  // The seed cannot have touched the lock before its own gate opens.
  expect(seed.output()).toBe('');

  writeFileSync(join(dataDir, SEED_GATE), 'go');
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
  it('lets exactly one of several real processes win, repeatedly', async () => {
    const rounds = 5;
    const contenders = 4;

    for (let round = 0; round < rounds; round += 1) {
      const dataDir = makeTempDir('sh-race-');
      try {
        const staleBytes = await createStaleLock(dataDir);
        const lockPath = join(dataDir, LOCK_FILE_NAME);
        const raceGate = join(dataDir, RACE_GATE);

        const participants = Array.from({ length: contenders }, () =>
          runContender(dataDir, RACE_GATE),
        );

        // 1. Every racer is up and waiting on the race gate …
        await waitFor(
          () => participants.every((participant) => existsSync(participant.readyPath)),
          15_000,
          `all ${contenders} contenders to be ready (round ${round})`,
        );

        // 2. … the gate is still closed, nobody has produced a result, and the
        //    stale lock is byte-identical: no contender reached the lock yet.
        expect(existsSync(raceGate)).toBe(false);
        expect(participants.map((participant) => participant.output())).toStrictEqual(
          Array.from({ length: contenders }, () => ''),
        );
        expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);

        // 3. Now release all of them at once.
        writeFileSync(raceGate, 'go');

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
          expect(['lock_held', 'lock_acquire_failed'], `round ${round}`).toContain(loser.code);
        }

        // 4. The winner's lock is the one on disk, and it is not the stale one.
        const onDisk = JSON.parse(readFileSync(lockPath, 'utf8')) as { bootToken?: string };
        expect(onDisk.bootToken).toBe(winners[0]?.token);
        expect(onDisk.bootToken).not.toBe(
          (JSON.parse(staleBytes) as { bootToken?: string }).bootToken,
        );

        // 5. Losers exit without disturbing the winner's lock.
        for (const participant of participants) {
          stopContender(participant);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));

        const after = JSON.parse(readFileSync(lockPath, 'utf8')) as { bootToken?: string };
        expect(after.bootToken).toBe(winners[0]?.token);
      } finally {
        killAll();
        removeTempDir(dataDir);
      }
    }
  });

  it('the winner keeps the lock: a later contender is refused', async () => {
    const dataDir = makeTempDir('sh-race-hold-');
    try {
      await createStaleLock(dataDir);
      const lockPath = join(dataDir, LOCK_FILE_NAME);

      const first = runContender(dataDir, RACE_GATE);
      await waitFor(() => existsSync(first.readyPath), 15_000, 'the first contender to be ready');
      expect(first.output()).toBe('');
      writeFileSync(join(dataDir, RACE_GATE), 'go');

      await waitFor(
        () => first.output().includes('"ok":true'),
        15_000,
        'the first contender to win',
      );
      const winner = JSON.parse(first.output().trim()) as ContenderResult;
      const heldBytes = readFileSync(lockPath, 'utf8');

      // The race gate already exists, so this contender proceeds immediately.
      const second = runContender(dataDir, RACE_GATE);
      await waitFor(
        () => second.output().includes('"ok"'),
        15_000,
        'the second contender to report',
      );
      const result = JSON.parse(second.output().trim()) as ContenderResult;

      expect(result.ok).toBe(false);
      expect(result.code).toBe('lock_held');

      expect(readFileSync(lockPath, 'utf8')).toBe(heldBytes);
      const onDisk = JSON.parse(heldBytes) as { bootToken?: string };
      expect(onDisk.bootToken).toBe(winner.token);
    } finally {
      killAll();
      removeTempDir(dataDir);
    }
  });
});
