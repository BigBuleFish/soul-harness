/**
 * Single Vitest entry point for the whole repo.
 *
 * Every workspace package under `packages/` is picked up as a project, so
 * `pnpm test` at the root runs the same suites a package runs on its own —
 * there is no second, drifting copy of the test configuration.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    passWithNoTests: false,
  },
});
