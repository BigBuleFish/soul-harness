/**
 * Test-only child-process watcher.
 *
 * `ChildProcess` emits `error` in two very different situations (verified on
 * Node 24 / Windows, and matching the documented POSIX behaviour):
 *
 *   - **spawn failure** — `error(ENOENT)` with `pid === undefined`, followed by
 *     `close(code = -4058)`. There is no process to wait for, so waiting would
 *     hang; the error is reported immediately.
 *   - **runtime error** — after a `spawn` event, e.g. a failed kill. The process
 *     still exists and its stdio is still open: only `close` proves the child is
 *     finished. The error is recorded and reported *after* `close`.
 *
 * That distinction is why a single "any error rejects the close promise" watcher
 * is wrong: it would declare a live process cleaned up.
 */

import type { ChildProcess } from 'node:child_process';

/** A child that never emits `close` is a bug, not something to wait out forever. */
export const CHILD_CLOSE_TIMEOUT_MS = 30_000;

export interface ChildWatch {
  /** Resolves on `close`; rejects only when the child could not be spawned. */
  readonly closed: Promise<void>;
  /** Errors emitted after the process started (e.g. a failed kill). */
  readonly runtimeErrors: readonly Error[];
  /** The spawn failure, when the process never started. */
  readonly spawnError: Error | null;
}

export interface Terminable {
  readonly child: ChildProcess;
  readonly watch: ChildWatch;
}

/**
 * Tracks one child from the moment it is spawned.
 *
 * Registered synchronously after `spawn()`, so no event can be missed. The
 * returned `closed` promise is created once and is the only completion signal.
 */
export function watchChild(child: ChildProcess): ChildWatch {
  const runtimeErrors: Error[] = [];
  let spawnError: Error | null = null;
  let started = false;
  let settled = false;

  let resolveClosed: () => void = () => undefined;
  let rejectClosed: (error: unknown) => void = () => undefined;

  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // A rejected close only surfaces through an awaiting cleanup; mark it handled
  // so an unrelated failure cannot crash the run with an unhandled rejection.
  closed.catch(() => undefined);

  const settle = (finish: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    finish();
  };

  const timer = setTimeout(() => {
    settle(() =>
      rejectClosed(
        new Error(
          `child ${String(child.pid)} neither spawned nor closed within ${CHILD_CLOSE_TIMEOUT_MS} ms`,
        ),
      ),
    );
  }, CHILD_CLOSE_TIMEOUT_MS);
  // The watchdog must not keep the test process alive by itself.
  timer.unref();

  child.once('spawn', () => {
    started = true;
  });

  child.once('error', (error: Error) => {
    if (started || child.pid !== undefined) {
      // The process exists (or existed): this is a runtime error. Keep it for
      // reporting, but never treat it as the end of the child's life.
      runtimeErrors.push(error);
      return;
    }
    // Never spawned: fail fast instead of waiting for a process that is not there.
    spawnError = error;
    settle(() => rejectClosed(error));
  });

  child.once('close', () => {
    settle(resolveClosed);
  });

  return {
    closed,
    get runtimeErrors(): readonly Error[] {
      return runtimeErrors;
    },
    get spawnError(): Error | null {
      return spawnError;
    },
  };
}

/**
 * Terminates one child and waits for `close`.
 *
 * SIGKILL is only sent while the process is still running; `close` is awaited in
 * every case. Runtime errors are surfaced *after* the close, so a failed kill can
 * never be mistaken for a completed cleanup.
 */
export async function terminateChild(entry: Terminable): Promise<void> {
  const { child, watch } = entry;

  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    child.kill('SIGKILL');
  }

  await watch.closed;

  if (watch.runtimeErrors.length > 0) {
    throw new AggregateError(
      [...watch.runtimeErrors],
      `child ${String(child.pid)} reported runtime errors while closing`,
    );
  }
}

/**
 * Terminates a batch and waits for **every** child's `close` before reporting.
 *
 * `Promise.all` would be wrong here: it rejects on the first failure while the
 * other children are still closing, and the caller would then delete the temp
 * directory under live processes. `allSettled` waits for all of them, then the
 * collected failures are re-thrown together.
 */
export async function terminateAll(entries: readonly Terminable[]): Promise<void> {
  const results = await Promise.allSettled(entries.map((entry) => terminateChild(entry)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} of ${entries.length} children did not close cleanly`,
    );
  }
}
