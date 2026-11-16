/**
 * Canonical identifier patterns.
 *
 * This file is the single source of truth for every wire-level identifier
 * shape. The same string literals are embedded into the JSON Schemas under
 * `src/schemas/`, so a schema and a runtime validator can never disagree.
 *
 * SECURITY: widening any pattern here silently widens every schema that
 * imports it. The six core ID patterns must stay byte-identical to
 * `docs/architecture/IDENTITY-PROTOCOL.md` §3.1; they are part of the frozen
 * identity contract (SH-003.2), not an implementation detail.
 */

/** Crockford Base32 alphabet: digits plus letters minus I, L, O, U. */
export const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

/** Encoded length of the (timestamp + random) body, excluding the prefix. */
export const ID_BODY_LENGTH = 26 as const;

/** Total wire length of a core or auxiliary identifier, including prefix. */
export const ID_TOTAL_LENGTH = 30 as const;

/** Core identity prefixes, in the order fixed by IDENTITY-PROTOCOL §3.1. */
export const CORE_ID_PREFIXES = ['psn', 'ses', 'thr', 'run', 'evt', 'act'] as const;

/**
 * Auxiliary prefixes. They share the identifier algorithm but are NOT part of
 * the six core identities and must be validated by a separate pattern.
 */
export const AUXILIARY_ID_PREFIXES = ['tsk', 'cnf'] as const;

/** Crockford Base32 body: exactly 26 characters, upper-case only. */
const BODY = '[0-9A-HJKMNP-TV-Z]{26}';

/**
 * The frozen six-class core pattern (IDENTITY-PROTOCOL §3.1).
 * Do not add auxiliary prefixes to this alternative group.
 */
export const CORE_ID_PATTERN = '^(psn|ses|thr|run|evt|act)_[0-9A-HJKMNP-TV-Z]{26}$' as const;

/** Auxiliary identifier pattern; deliberately disjoint from the core pattern. */
export const AUXILIARY_ID_PATTERN = '^(tsk|cnf)_[0-9A-HJKMNP-TV-Z]{26}$' as const;

export const PERSONA_ID_PATTERN = `^psn_${BODY}$` as const;
export const SESSION_ID_PATTERN = `^ses_${BODY}$` as const;
export const THREAD_ID_PATTERN = `^thr_${BODY}$` as const;
export const RUN_ID_PATTERN = `^run_${BODY}$` as const;
export const EVENT_ID_PATTERN = `^evt_${BODY}$` as const;
export const ACTION_ID_PATTERN = `^act_${BODY}$` as const;
export const TASK_ID_PATTERN = `^tsk_${BODY}$` as const;
export const CONFLICT_RECORD_ID_PATTERN = `^cnf_${BODY}$` as const;

/**
 * Controlled source identifier (adapter id / source). Lower-case only: an
 * upper-case variant is a different, unregistered identifier and must be
 * rejected rather than folded.
 */
export const ADAPTER_ID_PATTERN = '^[a-z0-9._-]{1,64}$' as const;

/** Source name; same shape and same registry rules as `adapterId`. */
export const SOURCE_PATTERN = '^[a-z0-9._-]{1,64}$' as const;

/**
 * Adapter-side stimulus reference. Opaque to the Harness, but constrained to a
 * character set that cannot carry prose, paths, URLs or error messages.
 */
export const ADAPTER_EVENT_REF_PATTERN = '^[A-Za-z0-9._:-]{1,64}$' as const;

/**
 * Delivery nonce. Cryptographically random, bound to one logical delivery.
 * Minimum 16 characters so a nonce cannot be a short guessable counter.
 */
export const REQUEST_NONCE_PATTERN = '^[A-Za-z0-9_-]{16,64}$' as const;

/** Opaque Archive reference emitted by the Archive Writer on `append`. */
export const ARCHIVE_REF_PATTERN = '^[A-Za-z0-9._:-]{1,128}$' as const;

/**
 * Daemon boot instance id. Not an identity: it answers "which process instance
 * is this" and must never be used as a credential.
 */
export const BOOT_ID_PATTERN = '^[A-Za-z0-9._:-]{1,64}$' as const;

/**
 * Extension payload discriminator: a namespaced, lower-case type name such as
 * `qq.message` or `mc.world`. The core contract fixes the *shape* only; the
 * concrete vocabulary belongs to adapter/plugin protocols.
 */
export const PAYLOAD_KIND_PATTERN = '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' as const;
