/* global setImmediate */
/**
 * Test fixture: runs the real daemon entry and raises a signal *in-process*.
 *
 * Windows cannot deliver SIGINT/SIGTERM from one Node process to another
 * (`child.kill('SIGTERM')` terminates instead of signalling), so the graceful
 * path is exercised here: the fixture calls the real `run()` from the built
 * entry and, once the daemon reports `RUNNING`, emits the same
 * `process 'SIGTERM'`/`'SIGINT'` event Node itself raises — which is exactly what
 * the handler in `main.ts` sees.
 *
 * The signal name comes from SOUL_TEST_SIGNAL (default SIGTERM).
 */

import { run } from '../../dist/main.js';

const signal = process.env.SOUL_TEST_SIGNAL ?? 'SIGTERM';
let sent = false;

const originalWrite = process.stdout.write.bind(process.stdout);
let buffer = '';

process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const result = originalWrite(chunk, ...rest);
  buffer += text;
  if (!sent && buffer.includes('"phase":"RUNNING"')) {
    sent = true;
    setImmediate(() => {
      process.emit(signal);
    });
  }
  return result;
};

const code = await run();
process.exitCode = code;
