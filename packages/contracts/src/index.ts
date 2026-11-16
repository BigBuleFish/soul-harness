/**
 * @soul-harness/contracts — the single source of truth for wire-level contracts.
 *
 * What this package IS:
 *   - protocol types, branded identifier types, controlled enums
 *   - JSON Schemas for every wire message
 *   - pure format validators (shape only)
 *   - version and capability constants
 *
 * What this package is NOT and must never become:
 *   - no ID generation (the runtime owns identity; IDENTITY-PROTOCOL §2)
 *   - no database access, no column mapping (persistence owns that)
 *   - no IO, no network, no filesystem, no clock access
 *   - no registry lookups (adapter-sdk owns registration)
 *   - no business rules beyond the encoded protocol constraints
 */

export type {
  ActionId,
  AdapterEventRef,
  AdapterId,
  ArchiveRef,
  AuxiliaryId,
  BootId,
  ConflictRecordId,
  CoreId,
  EventId,
  HarnessId,
  PersonaId,
  RequestNonce,
  RunId,
  SessionId,
  SourceId,
  TaskId,
  ThreadId,
} from './ids/types.js';

export {
  ADAPTER_EVENT_REF_PATTERN,
  ADAPTER_ID_PATTERN,
  ARCHIVE_REF_PATTERN,
  AUXILIARY_ID_PATTERN,
  AUXILIARY_ID_PREFIXES,
  BOOT_ID_PATTERN,
  CONFLICT_RECORD_ID_PATTERN,
  CORE_ID_PATTERN,
  CORE_ID_PREFIXES,
  EVENT_ID_PATTERN,
  ID_ALPHABET,
  ID_BODY_LENGTH,
  ID_TOTAL_LENGTH,
  PAYLOAD_KIND_PATTERN,
  PERSONA_ID_PATTERN,
  REQUEST_NONCE_PATTERN,
  ACTION_ID_PATTERN,
  RUN_ID_PATTERN,
  SESSION_ID_PATTERN,
  SOURCE_PATTERN,
  TASK_ID_PATTERN,
  THREAD_ID_PATTERN,
} from './ids/patterns.js';

export {
  isActionId,
  isAdapterEventRef,
  isAdapterId,
  isArchiveRef,
  isAuxiliaryId,
  isBootId,
  isConflictRecordId,
  isCoreId,
  isEventId,
  isPayloadKind,
  isPersonaId,
  isRequestNonce,
  isRunId,
  isSessionId,
  isSourceId,
  isTaskId,
  isThreadId,
  parseActionId,
  parseAdapterEventRef,
  parseAdapterId,
  parseArchiveRef,
  parseBootId,
  parseConflictRecordId,
  parseEventId,
  parsePersonaId,
  parseRequestNonce,
  parseRunId,
  parseSessionId,
  parseSourceId,
  parseTaskId,
  parseThreadId,
} from './ids/validate.js';

export type { JsonObject, JsonPrimitive, JsonValue } from './json.js';

export { CONTRACTS_VERSION, PROTOCOL_VERSION, SUPPORTED_STIMULUS_VERSIONS } from './version.js';
export type { ProtocolVersion } from './version.js';

export {
  ARCHIVE_DISPOSITIONS,
  ARCHIVE_STATES,
  ARCHIVE_WRITER_STATES,
  ATTENTION_OUTCOMES,
  CHANNELS,
  EVENT_STATUSES,
  RETENTION_CLASSES,
  isArchiveDisposition,
  isArchiveState,
  isArchiveWriterState,
  isAttentionOutcome,
  isChannel,
  isEventStatus,
  isRetentionClass,
} from './events/enums.js';
export type {
  ArchiveDisposition,
  ArchiveState,
  ArchiveWriterState,
  AttentionOutcome,
  Channel,
  EventStatus,
  RetentionClass,
} from './events/enums.js';

export {
  EXPIRED_REASONS,
  NON_TERMINAL_EVENT_STATUSES,
  REJECTED_REASONS,
  STATUS_REASONS,
  isExpiredReason,
  isRejectedReason,
  isStatusReason,
} from './events/status-reason.js';
export type {
  EventStatusWithReason,
  ExpiredReason,
  NonTerminalEventStatus,
  RejectedReason,
  StatusReason,
} from './events/status-reason.js';

export {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  RETRYABLE_ERROR_CODES,
  isErrorCode,
  isRetryableErrorCode,
} from './errors/codes.js';
export type { ErrorCode, RetryableErrorCode } from './errors/codes.js';
export type { ErrorBody, ErrorResponse } from './errors/error-response.js';

export type { StimulusPayload, StimulusV1 } from './envelope/v1.js';
export type { AckResponse } from './ack.js';

export {
  ARCHIVE_APPEND_RESULTS,
  ARCHIVE_COMPARE_RESULTS,
} from './archive/ipc.js';
export type {
  ArchiveAppendRequest,
  ArchiveAppendResponse,
  ArchiveAppendResult,
  ArchiveCompareRequest,
  ArchiveCompareResponse,
  ArchiveCompareResult,
  ArchiveStatusRequest,
  ArchiveStatusResponse,
} from './archive/ipc.js';

export {
  SCHEMAS,
  SCHEMA_IDS,
  ackResponseSchema,
  archiveAppendRequestSchema,
  archiveAppendResponseSchema,
  archiveCompareRequestSchema,
  archiveCompareResponseSchema,
  archiveStatusRequestSchema,
  archiveStatusResponseSchema,
  errorResponseSchema,
  stimulusV1Schema,
} from './schemas/index.js';
export type { JsonSchema, SchemaId } from './schemas/index.js';
