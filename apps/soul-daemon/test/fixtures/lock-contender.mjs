/**
 * Test fixture: one contender in the stale-lock race.
 *
 * Flow (a real barrier, so the contender cannot touch the lock before the gate):
 *   1. write `<dataDir>/ready-<gate>-<pid>` so the parent knows this process is up;
 *   2. spin until `<dataDir>/<gate>` exists — the gate is **per phase**, so the
 *      seed phase and the race phase never share one file;
 *   3. call the real `acquireInstanceLock` and print exactly one JSON line;
 *   4. on success, keep the lock (the parent inspects the file) until killed.
 *
 * Usage: node lock-contender.mjs <dataDir> <gateName>
 */

/* global setInterval */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireInstanceLock } from '../../dist/lock.js';

const dataDir = process.argv[2];
const gate = process.argv[3];

if (dataDir === undefined || gate === undefined) {
  throw new Error('usage: lock-contender.mjs <dataDir> <gateName>');
}

writeFileSync(join(dataDir, `ready-${gate}-${process.pid}`), 'ready');

while (!existsSync(join(dataDir, gate))) {
  // Busy-wait on the barrier; the parent creates the gate once every pid is ready.
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
