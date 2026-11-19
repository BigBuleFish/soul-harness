/**
 * Unit tests for the test-only child watcher.
 *
 * These pin the semantics the race test depends on:
 *   - a spawn failure must not hang (there is no process to wait for);
 *   - runtime `error` events never complete the close wait, and every one of them
 *     is reported together after `close`;
 *   - a timeout is a cleanup failure, never a "closed" child, and a caller that
 *     removes the temp directory only after a successful cleanup must not remove
 *     it in that case;
 *   - batch cleanup waits for every child, even when one of them fails.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  ChildCloseTimeoutError,
  terminateAll,
  terminateChild,
  watchChild,
  type Terminable,
} from './helpers/child-watch.js';

const children: Terminable[] = [];

afterEach(async () => {
  const pending = children.splice(0, children.length);
  await terminateAll(pending).catch(() => undefined);
});

function track(entry: Terminable): Terminable {
  children.push(entry);
  return entry;
}

/** Minimal stand-in for a started child that never closes. */
class NeverClosingChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}

function asChildProcess(fake: NeverClosingChild): ChildProcess {
  return fake as unknown as ChildProcess;
}

describe('watchChild', () => {
  it('fails fast when the process cannot be spawned', async () => {
    const child = spawn('definitely-not-a-real-binary-xyz123', []);
    const watch = watchChild(child);
    track({ child, watch });

    const started = Date.now();
    await expect(watch.closed).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(watch.spawnError?.message).toContain('ENOENT');
    expect(child.pid).toBeUndefined();
  });

  it('does not complete the wait for a runtime error before close', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const watch = watchChild(child);
    track({ child, watch });

    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));

    let settled = false;
    void watch.closed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // A runtime error while the process is alive must NOT finish the wait.
    child.emit('error', new Error('synthetic runtime error'));
    expect(settled).toBe(false);
    expect(watch.runtimeErrors).toHaveLength(1);

    // Only close finishes it — and the runtime error is reported afterwards.
    child.kill('SIGKILL');
    await expect(terminateChild({ child, watch })).rejects.toThrow(
      /runtime error\(s\) while closing/,
    );
    expect(settled).toBe(true);
  });

  it('records every consecutive runtime error and reports them together after close', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const watch = watchChild(child);
    track({ child, watch });

    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));

    let settled = false;
    void watch.closed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Two errors in a row: `once` would leave the second one unhandled.
    child.emit('error', new Error('runtime one'));
    child.emit('error', new Error('runtime two'));

    expect(settled).toBe(false);
    expect(watch.runtimeErrors.map((error) => error.message)).toStrictEqual([
      'runtime one',
      'runtime two',
    ]);

    child.kill('SIGKILL');
    await expect(terminateChild({ child, watch })).rejects.toThrow(/2 runtime error\(s\)/);
    expect(settled).toBe(true);
  });

  it('lets a normal child finish cleanly', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const watch = watchChild(child);
    track({ child, watch });

    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));

    await terminateChild({ child, watch });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(watch.runtimeErrors).toHaveLength(0);
    expect(watch.timedOut).toBe(false);
  });

  it('treats a missing close as a cleanup failure, never as closed', async () => {
    const fake = new NeverClosingChild();
    const child = asChildProcess(fake);
    const watch = watchChild(child, { timeoutMs: 100 });
    fake.emit('spawn');

    let closedResolved = false;
    void watch.closed.then(
      () => {
        closedResolved = true;
      },
      () => {
        closedResolved = true;
      },
    );

    // Mirror the callers: the temp directory is removed only when cleanup succeeds.
    let directoryRemoved = false;
    const cleanup = async (): Promise<void> => {
      await terminateAll([{ child, watch }]);
      directoryRemoved = true;
    };

    const started = Date.now();
    await expect(cleanup()).rejects.toBeInstanceOf(AggregateError);
    expect(Date.now() - started).toBeLessThan(5_000);

    let failures: unknown[] = [];
    try {
      await cleanup();
    } catch (error) {
      failures = (error as AggregateError).errors;
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(ChildCloseTimeoutError);
    expect((failures[0] as ChildCloseTimeoutError).pid).toBe(4242);

    // The timeout is not a close: nothing claimed the child was cleaned up.
    expect(watch.timedOut).toBe(true);
    expect(closedResolved).toBe(false);
    expect(directoryRemoved).toBe(false);
  });
});

describe('terminateAll', () => {
  it('waits for every child even when one of them fails', async () => {
    const healthyA = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const healthyB = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const broken = spawn('definitely-not-a-real-binary-xyz123', []);

    const entries: Terminable[] = [
      track({ child: healthyA, watch: watchChild(healthyA) }),
      track({ child: broken, watch: watchChild(broken) }),
      track({ child: healthyB, watch: watchChild(healthyB) }),
    ];

    let closedA = false;
    let closedB = false;
    void entries[0]?.watch.closed.then(() => {
      closedA = true;
    });
    void entries[2]?.watch.closed.then(() => {
      closedB = true;
    });

    await expect(terminateAll(entries)).rejects.toThrow(/did not close cleanly/);

    // Both healthy children finished closing before the failure was reported.
    expect(closedA).toBe(true);
    expect(closedB).toBe(true);
    expect(healthyA.exitCode !== null || healthyA.signalCode !== null).toBe(true);
    expect(healthyB.exitCode !== null || healthyB.signalCode !== null).toBe(true);
    expect(entries[1]?.watch.spawnError?.message).toContain('ENOENT');
  });

  it('does not skip other children when one of them times out', async () => {
    const stuck = new NeverClosingChild();
    const stuckChild = asChildProcess(stuck);
    const stuckWatch = watchChild(stuckChild, { timeoutMs: 150 });
    stuck.emit('spawn');

    const healthy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const healthyWatch = watchChild(healthy);
    track({ child: healthy, watch: healthyWatch });

    await expect(
      terminateAll([
        { child: stuckChild, watch: stuckWatch },
        { child: healthy, watch: healthyWatch },
      ]),
    ).rejects.toBeInstanceOf(AggregateError);

    // The healthy child still went through its real close.
    expect(healthy.exitCode !== null || healthy.signalCode !== null).toBe(true);
    expect(healthyWatch.timedOut).toBe(false);
  });
});
