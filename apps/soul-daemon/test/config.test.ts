import { describe, expect, it } from 'vitest';

import { CONFIG_ENV_VARS, CONFIG_LIMITS, loadConfig } from '../src/config.js';
import { isDaemonError } from '../src/errors.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isDaemonError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('configuration is explicit', () => {
  it('fails when the data directory is absent instead of guessing one', () => {
    expect(codeOf(() => loadConfig({}, 'C:\\work'))).toBe('config_missing');
  });

  it('treats an empty or whitespace-only data directory as missing', () => {
    expect(codeOf(() => loadConfig({ [CONFIG_ENV_VARS.dataDir]: '   ' }, 'C:\\work'))).toBe(
      'config_missing',
    );
  });

  it('resolves a relative data directory against the working directory', () => {
    const config = loadConfig({ [CONFIG_ENV_VARS.dataDir]: 'soul-data' }, 'C:\\work');
    expect(config.dataDir.endsWith('soul-data')).toBe(true);
    expect(config.dataDir.includes('soul-data')).toBe(true);
  });

  it('keeps an absolute data directory as given', () => {
    const absolute = process.platform === 'win32' ? 'C:\\soul-data' : '/soul-data';
    const config = loadConfig({ [CONFIG_ENV_VARS.dataDir]: absolute }, 'C:\\ignored');
    expect(config.dataDir).toBe(absolute);
  });

  it('rejects an unknown log level', () => {
    expect(
      codeOf(() =>
        loadConfig({ [CONFIG_ENV_VARS.dataDir]: 'x', [CONFIG_ENV_VARS.logLevel]: 'verbose' }),
      ),
    ).toBe('config_invalid');
  });

  it('rejects an out-of-range or non-numeric shutdown timeout', () => {
    for (const value of ['0', '99', '600001', '-5', 'abc', '1.5']) {
      expect(
        codeOf(() =>
          loadConfig({
            [CONFIG_ENV_VARS.dataDir]: 'x',
            [CONFIG_ENV_VARS.shutdownTimeoutMs]: value,
          }),
        ),
        value,
      ).toBe('config_invalid');
    }
  });

  it('applies documented defaults for optional values', () => {
    const config = loadConfig({ [CONFIG_ENV_VARS.dataDir]: 'x' });
    expect(config.logLevel).toBe('info');
    expect(config.shutdownTimeoutMs).toBe(CONFIG_LIMITS.shutdownTimeoutMs.fallback);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts an in-range timeout', () => {
    const config = loadConfig({
      [CONFIG_ENV_VARS.dataDir]: 'x',
      [CONFIG_ENV_VARS.shutdownTimeoutMs]: '2500',
    });
    expect(config.shutdownTimeoutMs).toBe(2500);
  });
});
