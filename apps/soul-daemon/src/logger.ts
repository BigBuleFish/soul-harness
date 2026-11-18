/**
 * Structured logging.
 *
 * One JSON object per line. Rules (RUNTIME-LIFECYCLE §2 step 2, TRUST-BOUNDARIES
 * §11.3): no event content, no memory content, no model input/output, no tokens
 * or keys — and no way to smuggle them in through an exception stack or a nested
 * object. Values that look like content are redacted by key before serialization,
 * and `Error` objects are reduced to `{ name, code, message }`.
 */

import type { LogLevel } from './config.js';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Keys whose values must never be written, regardless of content. */
const REDACTED_KEY =
  /(token|secret|password|passwd|apikey|api_key|credential|content|payload|prompt|transcript|memory|body)/iu;

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === 'string' ? { code } : {}),
      message: value.message,
    };
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, MAX_ARRAY).map((entry) => sanitizeValue(entry, depth + 1));
    return value.length > MAX_ARRAY ? [...visible, `[+${value.length - MAX_ARRAY} more]`] : visible;
  }
  if (typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function sanitizeRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = REDACTED_KEY.test(key) ? REDACTED : sanitizeValue(value, depth);
  }
  return result;
}

/** Builds a logger writing one JSON line per record. */
export function createLogger(options: LoggerOptions): Logger {
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? ((): Date => new Date());

  const emit = (level: LogLevel, bindings: LogFields, event: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.level]) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      event,
      ...sanitizeRecord(bindings, 0),
      ...sanitizeRecord(fields ?? {}, 0),
    };
    sink(JSON.stringify(record));
  };

  const make = (bindings: LogFields): Logger => ({
    level: options.level,
    debug: (event, fields) => emit('debug', bindings, event, fields),
    info: (event, fields) => emit('info', bindings, event, fields),
    warn: (event, fields) => emit('warn', bindings, event, fields),
    error: (event, fields) => emit('error', bindings, event, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  });

  return make({ pid: process.pid });
}
