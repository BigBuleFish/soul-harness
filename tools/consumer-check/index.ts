/**
 * Cross-package consumer check — compile half.
 *
 * This file is deliberately NOT part of `packages/contracts`: it exists to prove
 * that another workspace package can consume `@soul-harness/contracts` and
 * `@soul-harness/persistence` through their published entry points (package name,
 * not a relative path), and that the emitted `.d.ts` carries the intended types —
 * including the negative ones.
 *
 * It is typechecked by `pnpm run check:consumer`; it is never shipped.
 */

import {
  ERROR_MESSAGES,
  SCHEMAS,
  STIMULUS_INPUT_VERSION,
  isPersonaId,
  type AdapterId,
  type AdapterEventRef,
  type ArchiveAppendResponse,
  type BootId,
  type PersonaId,
  type RequestNonce,
  type SourceId,
  type StimulusInputV1,
} from '@soul-harness/contracts';
import {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  PersistenceError,
  createRepositories,
  isPersistenceError,
  openStore,
  withRead,
  withWrite,
  type Checkpoint,
  type CheckpointLoadResult,
  type ReadTx,
  type Store,
  type Tx,
} from '@soul-harness/persistence';
import {
  allocatePersonaId,
  allocateSessionId,
  createPersonaLifecycle,
  createScheduler,
  createStimulusIngress,
  recoverRuntime,
  type PersonaLifecycle,
  type PersonaSnapshot,
  type RecoverRuntimeOptions,
  type RecoveryPolicy,
  type RecoveryReport,
  type RuntimeLogger,
  type SchedulerOptions,
  type StimulusIngress,
  type TaskHandler,
  type TaskScheduler,
} from '@soul-harness/runtime';

export const personaId: PersonaId = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as PersonaId;

export const stimulus: StimulusInputV1 = {
  schema: STIMULUS_INPUT_VERSION,
  personaId,
  adapterId: 'minecraft' as AdapterId,
  source: 'minecraft.chat' as SourceId,
  adapterEventRef: 'mc-7f3a9c21' as AdapterEventRef,
  requestNonce: 'NQ7xK2mR9tVb4Wc8' as RequestNonce,
  payload: { kind: 'mc.world', version: 1 },
};

// @ts-expect-error receivedAt is not part of the adapter-submitted envelope
export const stimulusWithReceiptTime: StimulusInputV1 = { ...stimulus, receivedAt: 1 };

// @ts-expect-error archived requires an archiveRef
export const brokenAppendResponse: ArchiveAppendResponse = { result: 'archived' };

export const appendResponse: ArchiveAppendResponse = { result: 'conflict' };

export const schemaCount: number = Object.keys(SCHEMAS).length;
export const canonicalMessage: string = ERROR_MESSAGES.schema_invalid;
export const personaLooksValid: boolean = isPersonaId(personaId);

// --- persistence: the package must be usable from the outside -----------------

export const store: Store = openStore({ file: '.consumer-check.db' });
export const errorCode: string = new PersistenceError('store_closed', 'x').code;
export const isError: boolean = isPersistenceError(new PersistenceError('store_closed', 'x'));

export const checkpoint: Checkpoint = {
  schema: CHECKPOINT_SCHEMA,
  version: CHECKPOINT_VERSION,
  epoch: 1,
};

export const writeScope = <T>(fn: (tx: Tx) => T): T => withWrite(store, fn);
export const readScope = <T>(fn: (tx: ReadTx) => T): T => withRead(store, fn);

// @ts-expect-error a Tx handle exposes `prepare` only — there is no arbitrary exec
export const escapeAttempt = (tx: Tx): void => tx.exec('COMMIT');

// @ts-expect-error a ReadTx is not a write Tx (the `kind` discriminants differ)
export const readAsWrite = (tx: ReadTx): Tx => tx;

export const loadResult = (persona: PersonaId): CheckpointLoadResult =>
  createRepositories(store).checkpoints.load(persona);

// --- runtime: SH-008A publishes the allocator and nothing that pretends to run ---

const zeroEntropy = (): Uint8Array => new Uint8Array(10);

export const generatedPersona: PersonaId = allocatePersonaId({
  now: () => 0,
  randomBytes: zeroEntropy,
});

// @ts-expect-error a session id is not a persona id
export const sessionIsNotPersona: PersonaId = allocateSessionId({
  now: () => 0,
  randomBytes: zeroEntropy,
});

export const callerSuppliedId: PersonaId = allocatePersonaId({
  // @ts-expect-error callers cannot choose an internal identifier
  id: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC',
});

// --- runtime: SH-008B publishes the in-process persona lifecycle -------------

const consumerLogger: RuntimeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const personas: PersonaLifecycle = createPersonaLifecycle({
  store,
  logger: consumerLogger,
  bootId: 'consumer-boot' as BootId,
});

export const createdPersona: Promise<PersonaSnapshot> = personas.createPersona({
  displayName: 'Consumer',
});

export const chosenPersona: Promise<PersonaSnapshot> = personas.createPersona({
  displayName: 'Consumer',
  // @ts-expect-error callers cannot choose a persona id
  id: personaId,
});

export const badBoot: PersonaLifecycle = createPersonaLifecycle({
  store,
  logger: consumerLogger,
  // @ts-expect-error bootId is a BootId, not a number
  bootId: 1,
});

// --- runtime: SH-008C publishes the in-process ingress, not HTTP or the scheduler ---

export const ingress: StimulusIngress = createStimulusIngress({
  store,
  logger: consumerLogger,
  config: { queueCapacity: 4, bufferTtlMs: 60_000, personaAdmissionCapacity: 8 },
});

export const admitted = ingress.acceptStimulus({ stimulus });

export const unbounded: StimulusIngress = createStimulusIngress({
  store,
  logger: consumerLogger,
  // @ts-expect-error queue capacity and buffer TTL are required
  config: {},
});

// --- runtime: SH-008D D4 — Recovery and Scheduler through the public API -----

export const sharedPolicy: RecoveryPolicy = { maxAttempts: 3, retryBackoffMs: 0 };

export const consumerHandler: TaskHandler = (task, context) => {
  // A handler sees the claimed row and run identity; it cannot write task state.
  void task.id;
  void task.attempt;
  void context.runId;
  void context.signal.aborted;
  context.logger.info('consumer.handler', { taskId: task.id });
};

export const handlerMap: ReadonlyMap<string, TaskHandler> = new Map([
  ['thought.run', consumerHandler],
]);

export const recoveryOptions: RecoverRuntimeOptions = {
  store,
  logger: consumerLogger,
  policy: sharedPolicy,
  now: () => 0,
};

export const pendingRecovery: Promise<RecoveryReport> = recoverRuntime(recoveryOptions);

export const schedulerOptions: SchedulerOptions = {
  store,
  logger: consumerLogger,
  policy: sharedPolicy,
  handlers: handlerMap,
  now: () => 0,
  timers: { setTimeout: () => 0, clearTimeout: () => undefined },
};

export const scheduler: TaskScheduler = createScheduler(schedulerOptions);

export const policyIsShared: boolean = recoveryOptions.policy === schedulerOptions.policy;

// @ts-expect-error Recovery policy is required; there is no library default.
export const recoveryWithoutPolicy: RecoverRuntimeOptions = {
  store,
  logger: consumerLogger,
};

// @ts-expect-error Scheduler policy is required (D-RT2/D-RT3: no library default).
export const schedulerWithoutPolicy: SchedulerOptions = {
  store,
  logger: consumerLogger,
  handlers: handlerMap,
};

// @ts-expect-error handlers are required; P1 fixes the map at creation.
export const schedulerWithoutHandlers: SchedulerOptions = {
  store,
  logger: consumerLogger,
  policy: sharedPolicy,
};

// @ts-expect-error the shared policy must carry both approved fields.
export const incompletePolicy: RecoveryPolicy = { maxAttempts: 3 };

export const schedulerWithRegister: TaskScheduler = {
  ...scheduler,
  // @ts-expect-error there is no runtime registerHandler on the public Scheduler.
  registerHandler: () => () => undefined,
};
