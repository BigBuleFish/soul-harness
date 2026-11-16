/**
 * Cross-package consumer check — runtime half.
 *
 * Imports the package by name (resolved through the workspace link) and asserts
 * that the built ESM entry actually exposes the contract surface. Runs after
 * `pnpm run build`, so it validates `dist/`, not the sources.
 */

import assert from 'node:assert/strict';

import {
  ERROR_MESSAGES,
  SCHEMA_IDS,
  STIMULUS_INPUT_VERSION,
  isCoreId,
  isPersonaId,
  stimulusInputV1Schema,
} from '@soul-harness/contracts';

assert.equal(SCHEMA_IDS.length, 10, 'expected 10 registered schemas');
assert.equal(STIMULUS_INPUT_VERSION, 'soul.stimulus.input.v1');
assert.equal(stimulusInputV1Schema.$id, 'soul.stimulus.input.v1');
assert.equal(isPersonaId('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC'), true);
assert.equal(isCoreId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF'), false);
assert.equal(ERROR_MESSAGES.schema_invalid, 'envelope failed schema validation');

console.log(`consumer-check ok: package-name import resolved, ${SCHEMA_IDS.length} schemas`);
