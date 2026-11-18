/**
 * Test fixture: one contender in the stale-lock race.
 *
 * Flow (a real barrier, so the contenders truly compete at the same instant):
 *   1. write `<dataDir>/ready-<pid>` so the parent knows every process is up;
 *   2. spin until `<dataDir>/go` exists;
 *   3. call the real `acquireInstanceLock` and print one JSON line;
 *   4. on success, keep the lock (the parent inspects the file) until killed.
 *
 * Usage: node lock-contender.mjs <dataDir>
 */

/* global setInterval */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireInstanceLock } from '../../dist/lock.js';

const dataDir = process.argv[2];

if (dataDir === undefined) {
  throw new Error('dataDir argument is required');
}

writeFileSync(join(dataDir, `ready-${process.pid}`), 'ready');

while (!existsSync(join(dataDir, 'go'))) {
  // Busy-wait on the barrier; the parent creates it once every pid is ready.
}

try {
  const lock = acquireInstanceLock(dataDir);
  process.stdout.write(
    `${JSON.stringify({ ok: true, token: lock.holder.bootToken, pid: process.pid })}\n`,
  );
  // Hold the lock so the parent can prove nobody removed it. The parent kills us.
  setInterval(() => undefined, 1000);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error.code ?? 'unknown', message: error.message })}\n`,
  );
  process.exit(0);
}
