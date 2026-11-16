/**
 * ESLint flat config for the whole repo.
 *
 * Scope: `docs/` is prose and is not linted; `dist/`, `.turbo/` and the local
 * scratch/backup directories are not source. Rules extend the recommended
 * TypeScript set with two house rules that matter here: type-only imports (so
 * `verbatimModuleSyntax` stays honest) and no stray console output in library
 * code.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '.github/**',
      'docs/**',
      // Local, git-ignored scratch space and legacy data. Never part of a build.
      '_scratch/**',
      '_backup/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
