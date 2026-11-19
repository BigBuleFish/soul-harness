/**
 * Unit tests for the test-only child watcher.
 *
 * These pin the two semantics the race test depends on:
 *   - a spawn failure must not hang (there is no process to wait for);
 *   - a runtime `error` must not complete the close wait, and must still be
 *     reported once `close` arrives;
 *   - batch cleanup waits for every child, even when one of them fails.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
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
    await expect(terminateChild({ child, watch })).rejects.toThrow(/runtime errors while closing/);
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
});
