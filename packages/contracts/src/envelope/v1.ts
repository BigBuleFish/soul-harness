/**
 * Stimulus envelope v1 — the only way a stimulus enters the Harness.
 *
 * Design split (SH-004 decision B1):
 *   - The **envelope** owns the stable, core fields: event identity, delivery
 *     identity, persona scope, source attribution and timestamps.
 *   - The **payload** is an open, versioned extension area owned by adapter /
 *     plugin protocols. The core contract fixes its *shape* (a JSON object with
 *     a namespaced `kind` and a `version`) and never enumerates platform event
 *     types. QQ messages, Minecraft state and multimodal data all live there.
 *
 * Nothing in the core may read identity, authorization or persona scope out of
 * `payload`: those are envelope fields and are validated independently, so an
 * extension cannot bypass them by smuggling a `personaId` key into the payload.
 */

import type { AdapterEventRef, AdapterId, PersonaId, RequestNonce, SourceId } from '../ids/types.js';
import type { JsonObject } from '../json.js';
import type { ProtocolVersion } from '../version.js';

/**
 * Open extension payload.
 *
 * `kind` is a namespaced, lower-case type name (`qq.message`, `mc.world`, …)
 * whose vocabulary is defined by the adapter protocol, not here.
 * `version` lets an adapter evolve its own payload without a core version bump.
 * Additional properties are explicitly allowed: this is the designated
 * extension area, and it is the only place where unknown keys are tolerated.
 */
export type StimulusPayload = JsonObject & {
  readonly kind: string;
  readonly version: number;
};

/** v1 stimulus envelope. `additionalProperties` is false at this level. */
export interface StimulusV1 {
  /** Always `soul.stimulus.v1`; drives version negotiation. */
  readonly schema: ProtocolVersion;
  /** Target persona. Explicit, never inferred from "most recent session". */
  readonly personaId: PersonaId;
  /** Registered adapter that produced the stimulus. `system.*` for internal. */
  readonly adapterId: AdapterId;
  /** Registered source name, authorized for that adapter. */
  readonly source: SourceId;
  /** Adapter-side stimulus reference; retries of one stimulus MUST reuse it. */
  readonly adapterEventRef: AdapterEventRef;
  /** Per-delivery nonce; internal retries of one delivery MUST reuse it. */
  readonly requestNonce: RequestNonce;
  /** Unix milliseconds at which Ingress accepted the envelope. */
  readonly receivedAt: number;
  /** Unix milliseconds at which the stimulus happened, when known. */
  readonly occurredAt?: number;
  /** Open, versioned extension area. */
  readonly payload: StimulusPayload;
}
