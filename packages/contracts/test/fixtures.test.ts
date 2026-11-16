import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SCHEMA_IDS, type SchemaId } from '../src/schemas/index.js';
import { isValid } from './helpers/validator.js';

interface Fixture {
  readonly schema: SchemaId;
  readonly expect: 'valid' | 'invalid';
  readonly why: string;
  readonly doc: unknown;
}

const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.fixture.json'))
  .sort();

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as Fixture;
}

describe('fixtures', () => {
  it('exist in both polarities', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    const all = fixtures.map(loadFixture);
    expect(all.some((fixture) => fixture.expect === 'valid')).toBe(true);
    expect(all.some((fixture) => fixture.expect === 'invalid')).toBe(true);
  });

  it('every fixture names a registered schema', () => {
    for (const name of fixtures) {
      const fixture = loadFixture(name);
      expect(SCHEMA_IDS, name).toContain(fixture.schema);
      expect(fixture.why.length, name).toBeGreaterThan(0);
    }
  });

  it.each(fixtures)('fixture %s matches its expectation', (name) => {
    const fixture = loadFixture(name);
    const actual = isValid(fixture.schema, fixture.doc);
    expect(actual, `${name}: ${fixture.why}`).toBe(fixture.expect === 'valid');
  });
});
