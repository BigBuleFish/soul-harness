import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level,
      sink: (line: string) => lines.push(line),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
}

describe('structured logging', () => {
  it('emits one JSON object per line with the bound context', () => {
    const { lines, logger } = capture();
    logger.child({ personaId: 'psn_x' }).info('phase_entered', { phase: 'RUNNING' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'phase_entered',
      personaId: 'psn_x',
      phase: 'RUNNING',
    });
  });

  it('redacts content-bearing keys at any depth', () => {
    const { lines, logger } = capture();
    logger.info('test', {
      token: 'secret-token',
      content: 'the persona said hello',
      payload: { nested: 'memory body' },
      memory: ['a fragment'],
      safe: 'kept',
      deep: { apiKey: 'k', note: 'ok' },
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['token']).toBe('[redacted]');
    expect(record['content']).toBe('[redacted]');
    expect(record['payload']).toBe('[redacted]');
    expect(record['memory']).toBe('[redacted]');
    expect(record['safe']).toBe('kept');
    expect(record['deep']).toStrictEqual({ apiKey: '[redacted]', note: 'ok' });
  });

  it('reduces errors to name/code/message and never writes a stack', () => {
    const { lines, logger } = capture();
    const error = new Error('boom');
    (error as Error & { code?: string }).code = 'lock_held';

    logger.error('fatal', { error });

    const record = JSON.parse(lines[0] as string) as { error?: Record<string, unknown> };
    expect(record.error).toStrictEqual({ name: 'Error', code: 'lock_held', message: 'boom' });
    expect(JSON.stringify(record)).not.toContain('at ');
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toStrictEqual([
      'w',
      'e',
    ]);
  });
});
