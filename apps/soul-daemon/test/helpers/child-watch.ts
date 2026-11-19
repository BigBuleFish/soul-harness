/**
 * Test-only child-process watcher.
 *
 * `ChildProcess` emits `error` in two very different situations (verified on
 * Node 24 / Windows, matching the documented POSIX behaviour):
 *
 *   - **spawn failure** — `error(ENOENT)` with `pid === undefined`, followed by
 *     `close(code = -4058)`. There is no process to wait for, so the failure is
 *     reported immediately instead of waiting forever.
 *   - **runtime error** — after a `spawn` event, e.g. a failed kill, and there can
 *     be more than one. The process still exists and its stdio is still open:
 *     **only `close` proves the child is finished**. Every runtime error is kept
 *     and reported together, *after* the close.
 *
 * The watchdog is deliberately **not** a close: if a started child never closes,
 * cleanup must be reported as failed while the process may still be alive.
 * Treating a timeout as "closed" would let the caller delete a directory that a
 * live process is still using.
 */

import type { ChildProcess } from 'node:child_process';

/** Default deadline for a child to emit `close`. */
export const CHILD_CLOSE_TIMEOUT_MS = 30_000;

export interface WatchOptions {
  /** Override the close deadline (tests use a short value). */
  readonly timeoutMs?: number;
}

/** Raised when a started child never emitted `close` in time. */
export class ChildCloseTimeoutError extends Error {
  readonly pid: number | undefined;
  readonly timeoutMs: number;

  constructor(pid: number | undefined, timeoutMs: number) {
    super(
      `child ${String(pid)} did not emit "close" within ${timeoutMs} ms; it may still be running`,
    );
    this.name = 'ChildCloseTimeoutError';
    this.pid = pid;
    this.timeoutMs = timeoutMs;
  }
}

export interface ChildWatch {
  /**
   * Resolves **only** on a real `close` event.
   * Rejects when the child could not be spawned (there is no process to wait for).
   */
  readonly closed: Promise<void>;
  /** Every error emitted after the process started, in order. */
  readonly runtimeErrors: readonly Error[];
  /** The spawn failure, when the process never started. */
  readonly spawnError: Error | null;
  /** True once the deadline passed without a `close`. Never means "closed". */
  readonly timedOut: boolean;
  /** The deadline this watcher actually uses (default or overridden). */
  readonly timeoutMs: number;
  /** @internal Resolves when the deadline passes; `terminateChild` races it. */
  readonly timeoutSignal: Promise<void>;
}

export interface Terminable {
  readonly child: ChildProcess;
  readonly watch: ChildWatch;
}

/**
 * Tracks one child from the moment it is spawned.
 *
 * The `error` listener is persistent (`on`, not `once`) — a started child may
 * report several runtime errors — and is detached once the child's life settles,
 * so nothing leaks. `closed` is created once and is the only close signal.
 */
export function watchChild(child: ChildProcess, options: WatchOptions = {}): ChildWatch {
  const timeoutMs = options.timeoutMs ?? CHILD_CLOSE_TIMEOUT_MS;
  const runtimeErrors: Error[] = [];

  let spawnError: Error | null = null;
  let timedOut = false;
  let started = false;
  let closedSettled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let resolveClosed: () => void = () => undefined;
  let rejectClosed: (error: unknown) => void = () => undefined;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // A rejected close only surfaces through an awaiting cleanup; mark it handled so
  // an unrelated failure cannot crash the run with an unhandled rejection.
  closed.catch(() => undefined);

  let resolveTimeout: () => void = () => undefined;
  const timeoutSignal = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });

  const detach = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    child.off('error', onError);
  };

  const settleClosed = (finish: () => void): void => {
    if (closedSettled) {
      return;
    }
    closedSettled = true;
    detach();
    finish();
  };

  function onError(error: Error): void {
    if (started || child.pid !== undefined) {
      // Runtime error: record it, never finish the wait on its behalf.
      runtimeErrors.push(error);
      return;
    }
    // Never spawned: fail fast instead of waiting for a process that is not there.
    spawnError = error;
    settleClosed(() => rejectClosed(error));
  }

  timer = setTimeout(() => {
    if (closedSettled) {
      return;
    }
    // A timeout is NOT a close: keep `closed` pending and signal separately.
    timedOut = true;
    resolveTimeout();
  }, timeoutMs);
  // The watchdog must not keep the test process alive by itself.
  timer.unref();

  child.on('error', onError);
  child.once('spawn', () => {
    started = true;
  });
  child.once('close', () => {
    settleClosed(resolveClosed);
  });

  return {
    closed,
    get runtimeErrors(): readonly Error[] {
      return runtimeErrors;
    },
    get spawnError(): Error | null {
      return spawnError;
    },
    get timedOut(): boolean {
      return timedOut;
    },
    timeoutMs,
    timeoutSignal,
  };
}

/**
 * Terminates one child and waits for its **real** close.
 *
 * SIGKILL is only sent while the process is still running. The wait ends on
 * `close`, on a spawn failure, or on the deadline — and the deadline case is
 * reported as a cleanup failure (`ChildCloseTimeoutError`), never as "closed".
 * Runtime errors are surfaced afterwards as a single `AggregateError`.
 */
export async function terminateChild(entry: Terminable): Promise<void> {
  const { child, watch } = entry;

  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    child.kill('SIGKILL');
  }

  const outcome: 'closed' | 'timeout' | { readonly error: unknown } = await Promise.race([
    watch.closed.then(
      () => 'closed' as const,
      (error: unknown) => ({ error }) as const,
    ),
    watch.timeoutSignal.then(() => 'timeout' as const),
  ]);

  if (outcome === 'timeout') {
    // Last attempt; the process may ignore it, which is exactly why this is a
    // failure rather than a completion.
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill('SIGKILL');
    }
    // Report the deadline this watcher actually used, not the module default.
    throw new ChildCloseTimeoutError(child.pid, watch.timeoutMs);
  }

  if (typeof outcome === 'object') {
    throw outcome.error;
  }

  if (watch.runtimeErrors.length > 0) {
    throw new AggregateError(
      [...watch.runtimeErrors],
      `child ${String(child.pid)} reported ${watch.runtimeErrors.length} runtime error(s) while closing`,
    );
  }
}

/**
 * Terminates a batch and waits for **every** child to settle before reporting.
 *
 * `Promise.all` would be wrong: it rejects on the first failure while the other
 * children (or an unclosed one) are still alive, and the caller would then delete
 * a directory that a live process may still be using. `allSettled` waits for all,
 * then the collected failures are re-thrown together.
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
