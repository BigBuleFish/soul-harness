/**
 * Single-instance lock, scoped to the data directory (RUNTIME-LIFECYCLE §9).
 *
 * Acquisition
 *   - The lock file is created with `wx` (O_CREAT|O_EXCL): atomic on Windows and
 *     POSIX, so two starters cannot both win.
 *   - A recorded PID is only a hint. If the process is alive — or we cannot prove
 *     it is gone (`EPERM`) — startup is refused and the lock is left untouched.
 *
 * Stale takeover (the part that needs care)
 *   A naive "read the dead holder, then rename/delete the fixed path" has a
 *   time-of-check/time-of-use hole: between the read and the unlink another
 *   contender can replace the file with its own *fresh* lock, and the second
 *   contender then destroys a live lock. Two daemons would run on one database.
 *
 *   The protocol here never acts on "whatever is at the path now". It acts on a
 *   **specific snapshot**:
 *
 *     1. read the lock file and keep its exact bytes (the snapshot);
 *     2. elect exactly one claimer for that snapshot by creating
 *        `<lock>.claim.<sha256(snapshot)>` exclusively — the name is derived from
 *        the snapshot, so every contender that saw the same stale lock competes
 *        for the same claim file and only one can create it;
 *     3. the claimer re-reads the lock file and proceeds **only if the bytes are
 *        still identical to the snapshot**; otherwise it refuses and touches
 *        nothing (a different lock lives there now);
 *     4. only then is the stale file unlinked, and the normal exclusive create
 *        decides the final winner.
 *
 *   Consequences: at most one process can be in steps 3/4 for a given snapshot,
 *   no process removes a lock it did not snapshot, and the last word always
 *   belongs to the atomic create. If a claim file survives a crash, takeover is
 *   refused rather than guessed (see `lock_acquire_failed` with `claimPath`).
 *
 * Release
 *   Only the owner releases: the file is re-read and its boot token compared; a
 *   mismatch means the file belongs to someone else and is left alone.
 *
 * Platform notes (verified on Windows / Node 24; POSIX semantics are the same):
 *   - `O_EXCL` is atomic on Windows and POSIX filesystems.
 *   - `process.kill(pid, 0)` reports liveness on both; `ESRCH` = no such process.
 *   - `unlink` is the only destructive primitive used; no advisory locking is
 *     assumed, because Node exposes none portably.
 *   - Known limitation: PID reuse. If a dead holder's PID was recycled by an
 *     unrelated process, startup refuses (conservative) and an operator must
 *     remove the lock file by hand. Guessing could run two daemons.
 *   - Known limitation: a crash between claim creation and stale-lock removal
 *     leaves `<lock>.claim.<hash>` behind; startup then refuses with that path in
 *     the details. `soul.db` is never touched in that state.
 */

import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

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

interface LockSnapshot {
  readonly raw: string;
  readonly holder: LockHolder;
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    // Invalid PIDs never reach this point: `parseLock` rejects them first.
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

function unreadable(message: string, lockPath: string, cause?: unknown): DaemonError {
  return new DaemonError('lock_unreadable', message, {
    ...(cause === undefined ? {} : { cause }),
    details: { lockPath },
  });
}

/**
 * Validates a lock file's payload.
 *
 * A PID that is not a positive safe integer makes the whole file untrustworthy:
 * treating `0` / `-1` / `1.5` as "dead" would silently authorize a takeover of a
 * file we do not understand, so those are rejected as unreadable instead.
 */
function parseLock(raw: string, lockPath: string): LockHolder {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw unreadable(
      'existing instance lock is not valid JSON; refusing to delete it automatically',
      lockPath,
      error,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw unreadable('existing instance lock has an unexpected shape', lockPath);
  }

  const record = parsed as Record<string, unknown>;
  const { pid, bootToken, startedAt, dataDir } = record;

  if (
    pid === undefined ||
    bootToken === undefined ||
    startedAt === undefined ||
    dataDir === undefined
  ) {
    throw unreadable('existing instance lock is missing required fields', lockPath);
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw unreadable('existing instance lock has an invalid pid', lockPath);
  }
  if (
    typeof bootToken !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof dataDir !== 'string'
  ) {
    throw unreadable('existing instance lock has invalid field types', lockPath);
  }

  return { pid, bootToken, startedAt, dataDir };
}

/** Reads the lock file, or returns null when it does not exist. */
function readLockFile(lockPath: string): LockSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw unreadable('existing instance lock could not be read', lockPath, error);
  }

  return { raw, holder: parseLock(raw, lockPath) };
}

/** Creates a file atomically; returns the open descriptor, or null on EEXIST. */
function tryCreate(path: string, content: string): number | null {
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
    writeSync(fd, content);
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

function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
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

      let current: LockSnapshot | null;
      try {
        current = readLockFile(path);
      } catch (error) {
        throw new DaemonError(
          'lock_release_failed',
          'instance lock could not be verified on release',
          { cause: error, details: { lockPath: path } },
        );
      }

      if (current === null) {
        return; // Already gone; nothing of ours to remove.
      }
      if (current.holder.bootToken !== holder.bootToken) {
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
 * @throws DaemonError `lock_unreadable` when an existing lock cannot be trusted
 * @throws DaemonError `lock_acquire_failed` when a stale claim is already in progress
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
  const holderContent = `${JSON.stringify(holder)}\n`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fd = tryCreate(lockPath, holderContent);
    if (fd !== null) {
      return makeLock(lockPath, holder, fd);
    }

    const snapshot = readLockFile(lockPath);
    if (snapshot === null) {
      continue; // The file vanished between create and read: retry the create.
    }

    if (isAlive(snapshot.holder.pid)) {
      throw new DaemonError('lock_held', 'another daemon instance holds this data directory', {
        details: { lockPath, pid: snapshot.holder.pid, startedAt: snapshot.holder.startedAt },
      });
    }

    // Elect exactly one claimer for *this exact snapshot*, then act only on it.
    const claimPath = `${lockPath}.claim.${digest(snapshot.raw)}`;
    const claim = tryCreate(
      claimPath,
      `${JSON.stringify({ pid: process.pid, bootToken: holder.bootToken, startedAt: holder.startedAt })}\n`,
    );

    if (claim === null) {
      // Someone else is taking over the same stale lock. Refuse rather than race.
      throw new DaemonError(
        'lock_acquire_failed',
        'another process is claiming the stale lock; retry once it is gone',
        { details: { lockPath, claimPath } },
      );
    }

    try {
      const current = readLockFile(lockPath);

      if (current === null) {
        continue; // The stale lock disappeared; retry the exclusive create.
      }
      if (current.raw !== snapshot.raw) {
        // The path holds a *different* lock now: never delete it.
        throw new DaemonError(
          'lock_held',
          'another daemon acquired the lock while this process was claiming it',
          { details: { lockPath, pid: current.holder.pid } },
        );
      }

      unlinkSync(lockPath);
    } finally {
      closeSync(claim);
      try {
        unlinkSync(claimPath);
      } catch {
        // A leftover claim file only blocks a *future* takeover of this snapshot;
        // it never blocks a normal create, so failing here would be worse.
      }
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
