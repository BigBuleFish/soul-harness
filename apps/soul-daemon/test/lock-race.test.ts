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
 *
 * Exit synchronisation: every child gets a `close` promise **at spawn time**, and
 * every path (kill, already-exited, spawn failure, afterEach, finally) awaits that
 * same promise. `exitCode` only proves the process exited; it does not prove the
 * stdio streams are drained, so it is never used as a substitute for `close`.
 *
 * After the round the winner's lock file is snapshotted as a **Buffer** and
 * compared byte-for-byte once every contender's `close` has fired.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  terminateAll,
  terminateChild,
  watchChild,
  type ChildWatch,
} from './helpers/child-watch.js';
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
  /** Created once at spawn; every cleanup path awaits this same instance. */
  readonly watch: ChildWatch;
  output(): string;
}

const contenders: Contender[] = [];

function forget(contender: Contender): void {
  const index = contenders.indexOf(contender);
  if (index >= 0) {
    contenders.splice(index, 1);
  }
}

/**
 * Terminates a contender and waits for its `close`.
 *
 * SIGKILL is only sent while the child is still running, but `close` is awaited
 * in every case — including a child that exited earlier and one that failed to
 * spawn (`exitCode` is never treated as proof that stdio is closed).
 */
async function terminate(contender: Contender): Promise<void> {
  await terminateChild({ child: contender.child, watch: contender.watch });
}

/** Terminates one contender, waits for `close`, and stops tracking it. */
async function stopAndWait(contender: Contender): Promise<void> {
  await terminate(contender);
  forget(contender);
}

/** Kills every tracked contender and waits for all of their `close` events. */
async function killAllAndWait(): Promise<void> {
  const pending = contenders.splice(0, contenders.length);
  await terminateAll(
    pending.map((contender) => ({ child: contender.child, watch: contender.watch })),
  );
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extra assertion on top of `close`: the PID must disappear from the process table.
 *
 * `close` is what proves the exit; on Windows the OS may still answer
 * `OpenProcess` for a just-terminated process for a short moment, so the probe is
 * retried against a bound instead of being read once (which made the assertion
 * flaky without making it stronger).
 */
async function waitUntilPidGone(pid: number | undefined, timeoutMs = 5_000): Promise<void> {
  if (pid === undefined) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} is still visible ${timeoutMs} ms after its close event`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await killAllAndWait();
});

beforeAll(() => {
  buildDaemonApp();
}, 60_000);

function runContender(dataDir: string, gate: string): Contender {
  const child = spawn(process.execPath, [LOCK_CONTENDER, dataDir, gate], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Registered immediately: from here on, every path can await the same watch.
  const watch = watchChild(child);

  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });

  const contender: Contender = {
    child,
    readyPath: join(dataDir, `ready-${gate}-${child.pid}`),
    watch,
    output: () => output,
  };
  contenders.push(contender);

  return contender;
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
async function createStaleLock(dataDir: string): Promise<Buffer> {
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

  await stopAndWait(seed);

  const lockPath = join(dataDir, LOCK_FILE_NAME);
  expect(existsSync(lockPath)).toBe(true);
  return readFileSync(lockPath);
}

describe('stale-lock takeover race', { timeout: 120_000 }, () => {
  it('lets exactly one of several real processes win, repeatedly', async () => {
    const rounds = 5;
    const racers = 4;

    for (let round = 0; round < rounds; round += 1) {
      const dataDir = makeTempDir('sh-race-');
      try {
        const staleBytes = await createStaleLock(dataDir);
        const lockPath = join(dataDir, LOCK_FILE_NAME);
        const raceGate = join(dataDir, RACE_GATE);
        const staleToken = (JSON.parse(staleBytes.toString('utf8')) as { bootToken?: string })
          .bootToken;

        const participants = Array.from({ length: racers }, () => runContender(dataDir, RACE_GATE));
        const pids = participants.map((participant) => participant.child.pid);

        // 1. Every racer is up and waiting on the race gate …
        await waitFor(
          () => participants.every((participant) => existsSync(participant.readyPath)),
          15_000,
          `all ${racers} contenders to be ready (round ${round})`,
        );

        // 2. … the gate is still closed, nobody has produced a result, and the
        //    stale lock is byte-identical: no contender reached the lock yet.
        expect(existsSync(raceGate)).toBe(false);
        expect(participants.map((participant) => participant.output())).toStrictEqual(
          Array.from({ length: racers }, () => ''),
        );
        expect(readFileSync(lockPath).equals(staleBytes)).toBe(true);

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

        // 4. Snapshot the winner's lock **as raw bytes** while it is held.
        const heldBytes = readFileSync(lockPath);
        const heldToken = (JSON.parse(heldBytes.toString('utf8')) as { bootToken?: string })
          .bootToken;
        expect(heldToken).toBe(winners[0]?.token);
        expect(heldToken).not.toBe(staleToken);

        // 5. Kill every contender (winner included) and wait for real `close`.
        await Promise.all(participants.map((participant) => stopAndWait(participant)));
        await Promise.all(pids.map((pid) => waitUntilPidGone(pid)));

        // 6. Full-byte comparison after every contender is closed: nothing removed
        //    or rewrote the winner's lock.
        const afterExitBytes = readFileSync(lockPath);
        expect(afterExitBytes.equals(heldBytes)).toBe(true);
      } finally {
        await killAllAndWait();
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
      const heldBytes = readFileSync(lockPath);

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

      // Byte-for-byte: the refused contender changed nothing.
      expect(readFileSync(lockPath).equals(heldBytes)).toBe(true);
      const onDiskToken = (JSON.parse(heldBytes.toString('utf8')) as { bootToken?: string })
        .bootToken;
      expect(onDiskToken).toBe(winner.token);

      await stopAndWait(second);
      await waitUntilPidGone(second.child.pid);
      expect(readFileSync(lockPath).equals(heldBytes)).toBe(true);
    } finally {
      await killAllAndWait();
      removeTempDir(dataDir);
    }
  });
});
