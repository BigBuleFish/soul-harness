/**
 * Branded identifier types.
 *
 * Branding is compile-time only: it adds no runtime representation and no
 * allocation. Its purpose is to make `EventId` and `ActionId` (or any two
 * identifier classes) non-interchangeable at call sites, which is the single
 * most common way an identity bug reaches production.
 *
 * Nothing in this file generates identifiers; generation belongs to the
 * runtime (IDENTITY-PROTOCOL §2). These types describe what a valid,
 * already-generated identifier looks like.
 */

declare const identifierBrand: unique symbol;

type Brand<TValue, TName extends string> = TValue & {
  readonly [identifierBrand]: TName;
};

/** Long-lived persona identity; the subject of all subjective state. */
export type PersonaId = Brand<string, 'PersonaId'>;

/** One adapter interaction window. Not a persona identity. */
export type SessionId = Brand<string, 'SessionId'>;

/** One internal thought process. May span sessions and restarts. */
export type ThreadId = Brand<string, 'ThreadId'>;

/** One execution attempt (a retry gets a new run). */
export type RunId = Brand<string, 'RunId'>;

/** One observation that already happened outside the Harness. */
export type EventId = Brand<string, 'EventId'>;

/** One real-world action intent; the idempotency identity of that intent. */
export type ActionId = Brand<string, 'ActionId'>;

/** Logical task id; survives retries (retries only rotate the `runId`). */
export type TaskId = Brand<string, 'TaskId'>;

/** Archive conflict record id. Never equal to the conflicting event id. */
export type ConflictRecordId = Brand<string, 'ConflictRecordId'>;

/** The six core identity classes. */
export type CoreId = PersonaId | SessionId | ThreadId | RunId | EventId | ActionId;

/** Identifiers that share the algorithm but are not core identities. */
export type AuxiliaryId = TaskId | ConflictRecordId;

/** Any Harness-generated opaque identifier. */
export type HarnessId = CoreId | AuxiliaryId;

/** Registered adapter identifier (lower-case, controlled character set). */
export type AdapterId = Brand<string, 'AdapterId'>;

/** Registered source name, scoped to an adapter registration. */
export type SourceId = Brand<string, 'SourceId'>;

/** Adapter-side stimulus reference; retries of one stimulus reuse it. */
export type AdapterEventRef = Brand<string, 'AdapterEventRef'>;

/** Per-delivery nonce; internal retries of one delivery reuse it. */
export type RequestNonce = Brand<string, 'RequestNonce'>;

/** Opaque handle to an archived original. Never a path, URI or key material. */
export type ArchiveRef = Brand<string, 'ArchiveRef'>;

/** Daemon process instance id. Never a credential. */
export type BootId = Brand<string, 'BootId'>;
