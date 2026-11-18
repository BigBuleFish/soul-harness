/**
 * Single-instance lock, scoped to the data directory (RUNTIME-LIFECYCLE §9).
 *
 * Design:
 *   - **Atomic creation.** The lock file is created with `wx` (O_CREAT|O_EXCL),
 *     so two starters cannot both win. "Check then create" would be a race.
 *   - **Liveness is not assumed.** A recorded PID is only a hint. If the process
 *     is alive — or we cannot prove it is gone (`EPERM`) — startup is refused and
 *     the lock is left untouched. Never delete a lock you cannot prove stale.
 *   - **Stale takeover is atomic.** A provably dead holder's lock is claimed by
 *     `rename`, which only one contender can win; the loser re-enters the create
 *     loop and observes the winner's fresh lock.
 *   - **Only the owner releases.** Release re-reads the file and compares the boot
 *     token; a mismatch means the file belongs to someone else, so it is left
 *     alone and the failure is reported.
 *
 * Platform notes (verified on Windows / Node 24; POSIX semantics below):
 *   - `O_EXCL` is atomic on Windows and POSIX filesystems.
 *   - `process.kill(pid, 0)` reports liveness on both; `ESRCH` = no such process.
 *   - Renaming onto a non-existent target is atomic on both.
 *   - Known limitation: PID reuse. If a dead holder's PID was recycled by an
 *     unrelated process, startup refuses (conservative) and an operator must
 *     remove the lock file by hand. Guessing could run two daemons.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DaemonError } from './errors.js';

export const LOCK_FILE_NAME = 'soul.lock';

export interface LockHolder {
  readonly pid: number;
  /** Unique per daemon boot; used to prove ownership on release. */
  readonly bootToken: string;
  readonly startedAt: string;
  readonly dataDir: string;
}

export interface InstanceLock {
  readonly path: string;
  readonly holder: LockHolder;
  /** Releases the lock; idempotent and owner-checked. */
  release(): void;
}

export interface AcquireLockOptions {
  readonly now?: () => Date;
  /** Liveness probe; injectable for tests, defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists, but we may not signal it" → treat as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readHolder(path: string): LockHolder {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DaemonError('lock_unreadable', 'existing instance lock could not be read', {
      cause: error,
      details: { lockPath: path },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DaemonError(
      'lock_unreadable',
      'existing instance lock is not valid JSON; refusing to delete it automatically',
      { cause: error, details: { lockPath: path } },
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new DaemonError('lock_unreadable', 'existing instance lock has an unexpected shape', {
      details: { lockPath: path },
    });
  }

  const record = parsed as Record<string, unknown>;
  const { pid, bootToken, startedAt, dataDir } = record;
  if (
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    typeof bootToken !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof dataDir !== 'string'
  ) {
    throw new DaemonError('lock_unreadable', 'existing instance lock is missing required fields', {
      details: { lockPath: path },
    });
  }

  return { pid, bootToken, startedAt, dataDir };
}

/** Creates the lock file atomically; returns the open descriptor, or null on EEXIST. */
function tryCreate(path: string, holder: LockHolder): number | null {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return null;
    }
    throw new DaemonError('lock_acquire_failed', 'instance lock could not be created', {
      cause: error,
      details: { lockPath: path },
    });
  }

  try {
    writeSync(fd, `${JSON.stringify(holder)}\n`);
    fsyncSync(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // Best effort; the original failure is what matters.
    }
    throw new DaemonError('lock_acquire_failed', 'instance lock could not be written', {
      cause: error,
      details: { lockPath: path },
    });
  }
}

function makeLock(path: string, holder: LockHolder, fd: number): InstanceLock {
  let released = false;

  return {
    path,
    holder,
    release: (): void => {
      if (released) {
        return;
      }
      released = true;

      try {
        closeSync(fd);
      } catch {
        // Already closed: harmless.
      }

      let current: LockHolder;
      try {
        current = readHolder(path);
      } catch (error) {
        const cause = (error as DaemonError).cause as NodeJS.ErrnoException | undefined;
        if (cause?.code === 'ENOENT') {
          return; // Already gone; nothing of ours to remove.
        }
        throw new DaemonError(
          'lock_release_failed',
          'instance lock could not be verified on release',
          {
            cause: error,
            details: { lockPath: path },
          },
        );
      }

      if (current.bootToken !== holder.bootToken) {
        throw new DaemonError(
          'lock_release_failed',
          'instance lock now belongs to another process; refusing to delete it',
          { details: { lockPath: path } },
        );
      }

      try {
        unlinkSync(path);
      } catch (error) {
        throw new DaemonError('lock_release_failed', 'instance lock could not be removed', {
          cause: error,
          details: { lockPath: path },
        });
      }
    },
  };
}

/**
 * Acquires the instance lock for `dataDir`.
 *
 * @throws DaemonError `lock_held` when another live daemon owns the directory
 * @throws DaemonError `lock_unreadable` when an existing lock cannot be interpreted
 */
export function acquireInstanceLock(
  dataDir: string,
  options: AcquireLockOptions = {},
): InstanceLock {
  const now = options.now ?? ((): Date => new Date());
  const isAlive = options.isAlive ?? defaultIsAlive;
  const lockPath = join(dataDir, LOCK_FILE_NAME);

  const holder: LockHolder = {
    pid: process.pid,
    bootToken: randomUUID(),
    startedAt: now().toISOString(),
    dataDir,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fd = tryCreate(lockPath, holder);
    if (fd !== null) {
      return makeLock(lockPath, holder, fd);
    }

    const existing = readHolder(lockPath);
    if (isAlive(existing.pid)) {
      throw new DaemonError('lock_held', 'another daemon instance holds this data directory', {
        details: { lockPath, pid: existing.pid, startedAt: existing.startedAt },
      });
    }

    // Provably dead holder: claim the stale file atomically, then retry creation.
    const stalePath = `${lockPath}.stale-${holder.bootToken}-${attempt}`;
    try {
      renameSync(lockPath, stalePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // Someone else claimed it first; retry the exclusive create.
      }
      throw new DaemonError('lock_acquire_failed', 'stale instance lock could not be claimed', {
        cause: error,
        details: { lockPath },
      });
    }

    try {
      unlinkSync(stalePath);
    } catch {
      // A leftover `.stale-*` file is inert; ignoring is safer than failing here.
    }
  }

  throw new DaemonError(
    'lock_acquire_failed',
    'instance lock could not be acquired after retries',
    {
      details: { lockPath },
    },
  );
}
