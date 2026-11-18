/**
 * `soul-daemon` entry point.
 *
 * Runs the lifecycle from `daemon.ts` and translates its outcome into a stable
 * exit code. This file contains no business logic: it assembles the pieces and
 * wires signals into the controlled stop path.
 *
 * Exit codes:
 *   0  clean stop (including "stopped before it finished booting")
 *   2  configuration error
 *   3  data directory error
 *   4  single-instance lock error
 *   5  startup failure (migration, store, schema …)
 *   6  shutdown completed with cleanup failures
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadConfig } from './config.js';
import { SoulDaemon } from './daemon.js';
import { isDaemonError } from './errors.js';
import { createLogger } from './logger.js';

export const EXIT_CODES = {
  ok: 0,
  config: 2,
  dataDir: 3,
  lock: 4,
  startup: 5,
  shutdown: 6,
} as const;

/** Maps a daemon failure to a stable process exit code. */
export function exitCodeFor(error: unknown): number {
  if (!isDaemonError(error)) {
    return EXIT_CODES.startup;
  }

  switch (error.code) {
    case 'config_missing':
    case 'config_invalid':
      return EXIT_CODES.config;
    case 'data_dir_invalid':
    case 'data_dir_unwritable':
      return EXIT_CODES.dataDir;
    case 'lock_held':
    case 'lock_unreadable':
    case 'lock_acquire_failed':
      return EXIT_CODES.lock;
    case 'startup_aborted':
      return EXIT_CODES.ok;
    case 'shutdown_failed':
      return EXIT_CODES.shutdown;
    default:
      return EXIT_CODES.startup;
  }
}

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const logger = createLogger({ level: 'error' });
    logger.error('fatal', {
      code: isDaemonError(error) ? error.code : 'config_invalid',
      message: error instanceof Error ? error.message : 'configuration rejected',
    });
    return exitCodeFor(error);
  }

  const logger = createLogger({ level: config.logLevel });
  const daemon = new SoulDaemon({ config, logger });

  const requestStop = (signal: string): void => {
    logger.info('signal_received', { signal });
    void daemon.stop(signal).catch(() => undefined);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  // A pending promise does not keep Node alive, and signal listeners alone are not
  // a portable keep-alive (on Windows they are not a libuv handle). A daemon must
  // stay up until it is told to stop, so hold one ref'd timer for the process
  // lifetime and clear it in the shutdown path.
  const keepAlive = setInterval(() => undefined, 60_000);

  let code: number = EXIT_CODES.ok;

  try {
    await daemon.start();
  } catch (error) {
    code = exitCodeFor(error);

    if (isDaemonError(error) && error.code === 'startup_aborted') {
      logger.info('boot_aborted', { reason: 'stop_requested' });
    } else {
      logger.error('fatal', {
        code: isDaemonError(error) ? error.code : 'startup_failed',
        message: error instanceof Error ? error.message : 'startup failed',
      });
      // The boot path already unwound its own resources; stop() makes that
      // official (idempotent) and guarantees the lock is released.
      await daemon.stop('startup_failed').catch(() => undefined);
    }
  }

  try {
    await daemon.whenStopped();
  } catch (error) {
    code = exitCodeFor(error);
    logger.error('fatal', {
      code: isDaemonError(error) ? error.code : 'shutdown_failed',
      message: error instanceof Error ? error.message : 'shutdown failed',
    });
  }

  clearInterval(keepAlive);
  return code;
}

const entryPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const invokedDirectly =
  entryPath !== undefined && resolve(entryPath).toLowerCase() === resolve(modulePath).toLowerCase();

if (invokedDirectly) {
  void run().then((code) => {
    process.exitCode = code;
  });
}
