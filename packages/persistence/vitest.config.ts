/**
 * Package-level Vitest configuration.
 *
 * Required because the repo root also has a `vitest.config.ts` that aggregates
 * projects. Without this file, running `vitest` from inside the package finds
 * the root config and tries to resolve `projects: ['packages/*']` relative to
 * this directory, which matches nothing.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
