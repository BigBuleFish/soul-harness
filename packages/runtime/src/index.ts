/**
 * @soul-harness/runtime — cognitive runtime.
 *
 * SH-008A scope (this entry, and nothing beyond it yet):
 *   - allocate the six core identities and the auxiliary `tsk` / `cnf` forms
 *   - injectable clock, entropy, and occupancy predicate
 *   - retry on collision, then fail; never overwrite
 *
 * What this package is NOT yet, and must not pretend to be:
 *   - no persona state machine, event bus, scheduler, or recovery scans
 *   - no Daemon wiring and no HTTP surface
 *   - no SQLite, no SQL, no column-name mapping
 *   - no Archive, Action Gateway, or Dream Sandbox
 *   - no path that accepts an externally chosen internal id
 */

export { RUNTIME_ERROR_CODES, RuntimeError, isRuntimeError } from './errors.js';
export type { RuntimeErrorCode } from './errors.js';

export {
  ALLOCATABLE_PREFIXES,
  ID_ALLOCATION_MAX_ATTEMPTS,
  ID_ENTROPY_BYTES,
  allocateActionId,
  allocateConflictRecordId,
  allocateEventId,
  allocateId,
  allocatePersonaId,
  allocateRunId,
  allocateSessionId,
  allocateTaskId,
  allocateThreadId,
} from './ids/allocate.js';
export type { AllocateOptions, AllocatablePrefix } from './ids/allocate.js';
