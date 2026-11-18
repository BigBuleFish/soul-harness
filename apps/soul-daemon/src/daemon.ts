/**
 * Daemon lifecycle.
 *
 * Implements the infrastructure half of RUNTIME-LIFECYCLE §2/§3 and nothing else:
 *
 *   BOOTING → MIGRATING → RECOVERING → READY → RUNNING
 *   RUNNING → DRAINING → CHECKPOINTING → CLOSING → STOPPED
 *
 * What is real: configuration, structured logging, data-directory probe, the
 * single-instance lock, opening SQLite, running migrations and verifying the
 * schema. What is **not** real yet, and is reported as such: persona recovery,
 * runtime recovery, event bus, scheduler, HTTP/WebSocket and health transport.
 * The daemon reaches `RUNNING` as a *process* that owns its database — not as a
 * recovered runtime, and every log line and report says so.
 *
 * Resource discipline: acquisition order is recorded, failures unwind it in
 * reverse, and cleanup failures are collected and reported instead of being
 * swallowed — a broken cleanup must never look like a clean shutdown.
 */

import { join } from 'node:path';

import { migrate, openStore, verifySchema, type Store } from '@soul-harness/persistence';

import type { DaemonConfig } from './config.js';
import { ensureDataDir } from './data-dir.js';
import { DaemonError, isDaemonError } from './errors.js';
import { acquireInstanceLock, type InstanceLock } from './lock.js';
import type { Logger } from './logger.js';
import {
  CAPABILITIES,
  STARTUP_STEPS,
  type DaemonCapabilities,
  type DaemonPhase,
  type LifecycleStep,
} from './phases.js';

export interface DaemonOptions {
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

export interface StepOutcome {
  readonly step: string;
  readonly status: 'ok' | 'failed';
  readonly code?: string;
}

export interface StartReport {
  readonly phase: 'RUNNING';
  readonly pid: number;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly appliedMigrations: readonly number[];
  readonly currentVersion: number;
  readonly skippedSteps: readonly string[];
  readonly capabilities: DaemonCapabilities;
}

export interface StopReport {
  readonly phase: 'STOPPED';
  readonly reason: string;
  readonly steps: readonly StepOutcome[];
}

export interface DaemonStatus {
  readonly phase: DaemonPhase;
  readonly pid: number;
  readonly dataDir: string;
  readonly startedAt: string | null;
  readonly storeOpen: boolean;
  readonly lockHeld: boolean;
  readonly lockPath: string | null;
  readonly capabilities: DaemonCapabilities;
}

interface Resource {
  readonly step: string;
  readonly release: () => void;
  released: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (error) => rejectFn?.(error),
  };
}

export class SoulDaemon {
  readonly #config: DaemonConfig;
  readonly #logger: Logger;
  readonly #clock: () => Date;

  #phase: DaemonPhase = 'BOOTING';
  #resources: Resource[] = [];
  #lock: InstanceLock | null = null;
  #store: Store | null = null;

  #startedAt: string | null = null;
  #stopRequested = false;
  #startPromise: Promise<StartReport> | null = null;
  #stopPromise: Promise<StopReport> | null = null;
  #lastStopReport: StopReport | null = null;

  readonly #shutdownDone = createDeferred<StopReport>();

  constructor(options: DaemonOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#clock = options.clock ?? ((): Date => new Date());
    // A shutdown rejection is reported to whoever awaits `whenStopped()`; this
    // handler only prevents an unhandled-rejection crash when nobody does.
    this.#shutdownDone.promise.catch(() => undefined);
  }

  get phase(): DaemonPhase {
    return this.#phase;
  }

  get status(): DaemonStatus {
    return {
      phase: this.#phase,
      pid: process.pid,
      dataDir: this.#config.dataDir,
      startedAt: this.#startedAt,
      storeOpen: this.#store !== null,
      lockHeld: this.#lock !== null,
      lockPath: this.#lock?.path ?? null,
      capabilities: CAPABILITIES,
    };
  }

  /** Resolves once the daemon has fully stopped; rejects if cleanup failed. */
  whenStopped(): Promise<StopReport> {
    return this.#shutdownDone.promise;
  }

  start(): Promise<StartReport> {
    if (this.#startPromise === null) {
      this.#startPromise = this.#boot();
    }
    return this.#startPromise;
  }

  /**
   * Requests a stop. Idempotent: repeated calls return the same promise.
   * Safe to call while booting — the boot aborts at its next step boundary.
   */
  stop(reason: string = 'requested'): Promise<StopReport> {
    this.#stopRequested = true;

    if (this.#stopPromise === null) {
      this.#stopPromise = (async (): Promise<StopReport> => {
        await this.#startPromise?.catch(() => undefined);
        return this.#shutdown(reason);
      })();
    }

    return this.#stopPromise;
  }

  async #boot(): Promise<StartReport> {
    const { dataDir } = this.#config;
    const skipped: string[] = [];

    this.#logger.info('boot_started', { dataDir, pid: process.pid });

    try {
      // 1. configuration (validated before construction; record the effective shape)
      this.#logger.info('step_ok', {
        step: 'config',
        logLevel: this.#config.logLevel,
        shutdownTimeoutMs: this.#config.shutdownTimeoutMs,
      });
      await this.#boundary();

      // 2. structured logging
      this.#logger.info('step_ok', { step: 'logging' });
      await this.#boundary();

      // 3. data directory + write probe
      ensureDataDir(dataDir);
      this.#logger.info('step_ok', { step: 'data_directory', dataDir });
      await this.#boundary();

      // 4. single-instance lock — before the database is touched
      const lock = acquireInstanceLock(dataDir);
      this.#lock = lock;
      this.#resources.push({
        step: 'instance_lock',
        release: () => lock.release(),
        released: false,
      });
      this.#logger.info('step_ok', {
        step: 'instance_lock',
        lockPath: lock.path,
        lockPid: lock.holder.pid,
      });
      await this.#boundary();

      // 5. SQLite
      const databaseFile = join(dataDir, 'soul.db');
      const store = openStore({ file: databaseFile });
      this.#store = store;
      this.#resources.push({ step: 'sqlite_open', release: () => store.close(), released: false });
      this.#logger.info('step_ok', { step: 'sqlite_open', databaseFile });
      await this.#boundary();

      // 6/7. migrations + schema verification
      this.#enter('MIGRATING');
      const migration = migrate(store);
      verifySchema(store);
      this.#logger.info('step_ok', {
        step: 'migrations',
        applied: migration.applied.length,
        currentVersion: migration.currentVersion,
      });
      this.#logger.info('step_ok', { step: 'schema_verification' });
      await this.#boundary();

      // 8/9. recovery — not implemented; reported, never faked
      this.#enter('RECOVERING');
      this.#skipSteps('RECOVERING', skipped);

      // 10–13. transports, scheduler, health — not implemented
      this.#enter('READY');
      this.#skipSteps('READY', skipped);
      await this.#boundary();

      // 14. running (as a process that owns its database, not as a recovered runtime)
      this.#enter('RUNNING');
      this.#startedAt = this.#clock().toISOString();
      this.#logger.info('daemon_running', {
        dataDir,
        databaseFile,
        runtime: 'not_implemented',
        recovery: 'not_implemented',
      });

      return {
        phase: 'RUNNING',
        pid: process.pid,
        dataDir,
        databaseFile,
        appliedMigrations: migration.applied,
        currentVersion: migration.currentVersion,
        skippedSteps: skipped,
        capabilities: CAPABILITIES,
      };
    } catch (error) {
      const cleanup = this.#releaseAll();
      this.#phase = 'FAILED';

      const code = isDaemonError(error) ? error.code : 'startup_failed';
      this.#logger.error('boot_failed', {
        code,
        cleanupFailures: cleanup.filter((entry) => entry.status === 'failed').length,
      });

      // A DaemonError already carries a precise code (lock_held, data_dir_invalid,
      // startup_aborted ?). Wrapping it would flatten every cause into exit code 5
      // and hide *why* the boot failed.
      if (isDaemonError(error)) {
        throw error;
      }
      throw new DaemonError('startup_failed', 'daemon failed to start', {
        cause: error,
        details: {
          code,
          cleanupFailures: cleanup.filter((entry) => entry.status === 'failed').length,
        },
      });
    }
  }

  async #shutdown(reason: string): Promise<StopReport> {
    if (this.#phase === 'STOPPED' && this.#lastStopReport !== null) {
      return this.#lastStopReport;
    }

    const ranForReal = this.#phase === 'RUNNING' || this.#phase === 'READY';
    const steps: StepOutcome[] = [];

    if (ranForReal) {
      this.#enter('DRAINING');
      this.#logger.info('drain_started', { reason });
      this.#logger.info('step_skipped', {
        step: 'scheduler_drain',
        owner: 'SH-008',
        reason: 'not_implemented',
      });
    }

    // Checkpointing is only legal when a runtime exists to produce one. Writing a
    // placeholder would fabricate state, so the step is reported as skipped.
    this.#logger.info('checkpoint_skipped', { reason: 'runtime_not_implemented' });

    this.#enter('CLOSING');
    steps.push(...this.#releaseAll());

    this.#enter('STOPPED');
    const report: StopReport = { phase: 'STOPPED', reason, steps };
    this.#lastStopReport = report;

    const failures = steps.filter((entry) => entry.status === 'failed');
    this.#logger.info('daemon_stopped', { reason, cleanupFailures: failures.length });

    if (failures.length > 0) {
      const error = new DaemonError('shutdown_failed', 'daemon stopped with cleanup failures', {
        details: { failures: failures.length, first: failures[0]?.step ?? 'unknown' },
      });
      this.#shutdownDone.reject(error);
      throw error;
    }

    this.#shutdownDone.resolve(report);
    return report;
  }

  #releaseAll(): StepOutcome[] {
    const outcomes: StepOutcome[] = [];

    for (const resource of [...this.#resources].reverse()) {
      if (resource.released) {
        continue;
      }
      resource.released = true;

      try {
        resource.release();
        outcomes.push({ step: resource.step, status: 'ok' });
      } catch (error) {
        const code = isDaemonError(error) ? error.code : 'shutdown_failed';
        outcomes.push({ step: resource.step, status: 'failed', code });
        this.#logger.error('cleanup_failed', { step: resource.step, code });
      }
    }

    this.#resources = [];
    if (outcomes.some((entry) => entry.step === 'instance_lock')) {
      this.#lock = null;
    }
    if (outcomes.some((entry) => entry.step === 'sqlite_open')) {
      this.#store = null;
    }

    return outcomes;
  }

  #skipSteps(phase: 'RECOVERING' | 'READY', skipped: string[]): void {
    for (const step of STARTUP_STEPS.filter((entry) => entry.phase === phase)) {
      skipped.push(step.id);
      this.#logSkipped(step);
    }
  }

  #logSkipped(step: LifecycleStep): void {
    this.#logger.info('step_skipped', {
      step: step.id,
      phase: step.phase,
      owner: step.owner ?? 'unassigned',
      reason: step.note,
      status: step.status,
    });
  }

  /**
   * Step boundary: yields to the event loop, then aborts if a stop was requested.
   *
   * The yield is what makes "stop during boot" real: signal handlers and
   * `stop()` calls run as macrotasks, so a boot that never yields could not be
   * interrupted even though the lifecycle promises it can.
   */
  async #boundary(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (this.#stopRequested) {
      throw new DaemonError('startup_aborted', 'stop requested while the daemon was booting');
    }
  }

  #enter(phase: DaemonPhase): void {
    this.#phase = phase;
    this.#logger.info('phase_entered', { phase });
  }
}
