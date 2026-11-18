/**
 * Lifecycle vocabulary.
 *
 * The phase names and their order come from RUNTIME-LIFECYCLE §2/§3 and are not
 * negotiable. The *steps* are listed explicitly with an honest status: this batch
 * implements the infrastructure half of the startup table, and everything that
 * depends on the Runtime, the event bus, the scheduler or the HTTP surface is
 * marked `not_implemented` with the stage that owns it.
 *
 * That is the difference between "the database is open" and "the runtime has
 * recovered": the daemon reports the former and refuses to claim the latter.
 */

export const BOOT_PHASES = ['BOOTING', 'MIGRATING', 'RECOVERING', 'READY', 'RUNNING'] as const;

export const SHUTDOWN_PHASES = ['DRAINING', 'CHECKPOINTING', 'CLOSING', 'STOPPED'] as const;

export type BootPhase = (typeof BOOT_PHASES)[number];
export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];
export type DaemonPhase = BootPhase | ShutdownPhase | 'FAILED';

export type StepStatus = 'implemented' | 'not_implemented';

export interface LifecycleStep {
  readonly id: string;
  readonly phase: BootPhase;
  readonly status: StepStatus;
  /** Stage that will implement the step, when known. */
  readonly owner?: string;
  readonly note: string;
}

/**
 * RUNTIME-LIFECYCLE §2 startup table, one entry per numbered step.
 * Order matters: it is the order the daemon walks (and the reverse of cleanup).
 */
export const STARTUP_STEPS: readonly LifecycleStep[] = [
  {
    id: 'config',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'explicit env config, no fallbacks',
  },
  {
    id: 'logging',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'structured JSON lines, content redacted',
  },
  {
    id: 'data_directory',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'directory + real write probe, no temp fallback',
  },
  {
    id: 'instance_lock',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'atomic, data-dir scoped, owner-checked release',
  },
  {
    id: 'sqlite_open',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'single writer, WAL',
  },
  {
    id: 'migrations',
    phase: 'MIGRATING',
    status: 'implemented',
    note: 'packaged migrations, checksum verified',
  },
  {
    id: 'schema_verification',
    phase: 'MIGRATING',
    status: 'implemented',
    note: 'expected P1 shape, column order included',
  },
  {
    id: 'persona_recovery',
    phase: 'RECOVERING',
    status: 'not_implemented',
    owner: 'SH-008',
    note: 'requires the Runtime package',
  },
  {
    id: 'runtime_recovery',
    phase: 'RECOVERING',
    status: 'not_implemented',
    owner: 'SH-008',
    note: 'checkpoint/queue/threads restore; not implemented',
  },
  {
    id: 'event_bus',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-008',
    note: 'no transport receives events yet',
  },
  {
    id: 'scheduler',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-008',
    note: 'no work is dispatched',
  },
  {
    id: 'http_api',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-009',
    note: 'loopback API/WebSocket not implemented',
  },
  {
    id: 'health_check',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-009',
    note: 'no health transport; status is available in-process only',
  },
];

/** Capabilities this build can honestly claim. */
export interface DaemonCapabilities {
  readonly persistence: true;
  readonly migrations: true;
  readonly instanceLock: true;
  readonly structuredLogging: true;
  readonly runtime: 'not_implemented';
  readonly recovery: 'not_implemented';
  readonly eventBus: 'not_implemented';
  readonly scheduler: 'not_implemented';
  readonly httpApi: 'not_implemented';
  readonly healthEndpoint: 'not_implemented';
}

export const CAPABILITIES: DaemonCapabilities = Object.freeze({
  persistence: true,
  migrations: true,
  instanceLock: true,
  structuredLogging: true,
  runtime: 'not_implemented',
  recovery: 'not_implemented',
  eventBus: 'not_implemented',
  scheduler: 'not_implemented',
  httpApi: 'not_implemented',
  healthEndpoint: 'not_implemented',
});
