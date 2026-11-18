/**
 * Daemon configuration.
 *
 * Rules (PLAN §5, RUNTIME-LIFECYCLE §2 step 1):
 *   - every critical value is explicit; a missing data directory fails the boot
 *     instead of silently falling back to a temp directory
 *   - validation happens once, up front; the daemon receives a frozen config and
 *     never re-reads `process.env`
 *   - the config carries no secrets today, and any future secret must stay out of
 *     the structured log (see `logger.ts` redaction)
 */

import { resolve } from 'node:path';

import { DaemonError } from './errors.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONFIG_ENV_VARS = {
  dataDir: 'SOUL_DATA_DIR',
  logLevel: 'SOUL_LOG_LEVEL',
  shutdownTimeoutMs: 'SOUL_SHUTDOWN_TIMEOUT_MS',
} as const;

export const CONFIG_LIMITS = {
  shutdownTimeoutMs: { min: 100, max: 600_000, fallback: 10_000 },
} as const;

export interface DaemonConfig {
  /** Absolute path of the data directory; the instance lock is scoped to it. */
  readonly dataDir: string;
  readonly logLevel: LogLevel;
  /** Bound for the graceful stop; a hung step must not block shutdown forever. */
  readonly shutdownTimeoutMs: number;
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Parses and validates the daemon configuration from the environment. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DaemonConfig {
  const rawDataDir = readRaw(env, CONFIG_ENV_VARS.dataDir);
  if (rawDataDir === undefined) {
    throw new DaemonError(
      'config_missing',
      `${CONFIG_ENV_VARS.dataDir} is required; the daemon never falls back to a temp directory`,
      { details: { variable: CONFIG_ENV_VARS.dataDir } },
    );
  }

  const dataDir = resolve(cwd, rawDataDir);

  const rawLogLevel = readRaw(env, CONFIG_ENV_VARS.logLevel);
  const logLevel: LogLevel = rawLogLevel === undefined ? 'info' : (rawLogLevel as LogLevel);
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(logLevel)) {
    throw new DaemonError(
      'config_invalid',
      `${CONFIG_ENV_VARS.logLevel} must be one of the documented levels`,
      {
        details: { variable: CONFIG_ENV_VARS.logLevel },
      },
    );
  }

  const rawTimeout = readRaw(env, CONFIG_ENV_VARS.shutdownTimeoutMs);
  const limit = CONFIG_LIMITS.shutdownTimeoutMs;
  let shutdownTimeoutMs: number = limit.fallback;
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < limit.min || parsed > limit.max) {
      throw new DaemonError(
        'config_invalid',
        `${CONFIG_ENV_VARS.shutdownTimeoutMs} must be an integer between ${limit.min} and ${limit.max}`,
        {
          details: { variable: CONFIG_ENV_VARS.shutdownTimeoutMs, min: limit.min, max: limit.max },
        },
      );
    }
    shutdownTimeoutMs = parsed;
  }

  return Object.freeze({ dataDir, logLevel, shutdownTimeoutMs });
}
