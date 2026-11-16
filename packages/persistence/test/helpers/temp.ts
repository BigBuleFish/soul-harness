/**
 * Test helpers.
 *
 * Every test uses a real SQLite file in a temp directory and the real migration
 * loader — synthetic cases are injected as real `.sql` files so the execution,
 * checksum and transaction paths are the production ones.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDir(prefix = 'sh-persist-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows keeps file locks briefly; retry the recursive delete. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function dbPathIn(dir: string): string {
  return join(dir, 'soul.db');
}

export function writeMigrationFile(dir: string, fileName: string, sql: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, sql, 'utf8');
  return path;
}

export function copyMigrations(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}
