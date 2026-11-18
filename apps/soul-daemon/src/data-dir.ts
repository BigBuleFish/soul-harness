/**
 * Data directory preparation.
 *
 * RUNTIME-LIFECYCLE §2 step 3: verify the directory and its write permission, and
 * **never** fall back to a temp directory. The check is a real probe file, not a
 * `stat` — on Windows an ACL can deny creation inside an otherwise normal-looking
 * directory, and a probe is the only honest answer to "can we write here".
 */

import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DaemonError } from './errors.js';

export function ensureDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new DaemonError('data_dir_invalid', 'data directory could not be created', {
      cause: error,
      details: { dataDir: dir },
    });
  }

  let stat;
  try {
    stat = statSync(dir);
  } catch (error) {
    throw new DaemonError('data_dir_invalid', 'data directory is not accessible', {
      cause: error,
      details: { dataDir: dir },
    });
  }

  if (!stat.isDirectory()) {
    throw new DaemonError('data_dir_invalid', 'data directory path is not a directory', {
      details: { dataDir: dir },
    });
  }

  const probe = join(dir, `.soul-write-probe-${randomUUID()}`);
  try {
    writeFileSync(probe, 'soul-harness write probe', { mode: 0o600 });
  } catch (error) {
    throw new DaemonError('data_dir_unwritable', 'data directory is not writable', {
      cause: error,
      details: { dataDir: dir },
    });
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // The probe may not have been created; a leftover probe would be harmless,
      // but silently ignoring the removal failure would hide a real permission gap.
    }
  }
}
