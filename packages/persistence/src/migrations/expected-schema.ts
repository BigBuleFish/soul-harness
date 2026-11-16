/**
 * Expected P1 schema.
 *
 * One list of truth used by two consumers:
 *   - `verifySchema()` — proves an opened database really is at the expected shape
 *   - the field-mapping tests (batch B) — every column round-trips snake↔camel
 *
 * Derived from DATA-MODEL.md §3. When a migration adds or renames a column the
 * identifier in this file must be updated in the same change, otherwise
 * `verifySchema()` fails — which is the intended alarm.
 */

export const P1_TABLE_COLUMNS = {
  personas: [
    'id',
    'display_name',
    'state',
    'version',
    'epoch',
    'boot_id',
    'created_at',
    'updated_at',
  ],
  sessions: [
    'id',
    'persona_id',
    'adapter_id',
    'external_id',
    'opened_at',
    'closed_at',
    'meta_json',
  ],
  events: [
    'id',
    'persona_id',
    'session_id',
    'source',
    'adapter_id',
    'adapter_event_ref',
    'status',
    'attention_outcome',
    'salience',
    'summary',
    'archive_ref',
    'received_at',
    'occurred_at',
    'updated_at',
    'archive_disposition',
    'archive_state',
    'status_reason',
  ],
  tasks: [
    'id',
    'persona_id',
    'kind',
    'channel',
    'state',
    'priority',
    'run_id',
    'payload_json',
    'scheduled_at',
    'started_at',
    'finished_at',
    'attempt',
  ],
  runtime_state: ['persona_id', 'state', 'boot_id', 'epoch', 'checkpoint_json', 'updated_at'],
  schema_migrations: ['version', 'name', 'checksum', 'applied_at'],
} as const satisfies Record<string, readonly string[]>;

export type P1TableName = keyof typeof P1_TABLE_COLUMNS;

export const P1_INDEXES = [
  'ix_sessions_persona',
  'ux_sessions_external',
  'ix_events_persona_status',
  'ix_events_session',
  'ux_events_dedupe',
  'ix_tasks_persona_state',
] as const;
