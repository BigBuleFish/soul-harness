/**
 * Protocol version constants.
 *
 * There are two envelopes, and they are deliberately distinct:
 *
 *   adapter ──StimulusInputV1──▶ Ingress ──StimulusV1──▶ Runtime
 *
 * `StimulusInputV1` is what an adapter may submit: it carries no `receivedAt`,
 * because receipt time is an authority the adapter must not possess.
 * `StimulusV1` is the normalized envelope produced by Ingress after it stamps
 * `receivedAt` inside the trusted receive path. Runtime only ever sees this one.
 */

/** Adapter → Ingress wire version. The only version adapters may submit. */
export const STIMULUS_INPUT_VERSION = 'soul.stimulus.input.v1' as const;

export type StimulusInputVersion = typeof STIMULUS_INPUT_VERSION;

/** Ingress → Runtime normalized version. Never accepted from an adapter. */
export const STIMULUS_VERSION = 'soul.stimulus.v1' as const;

export type StimulusVersion = typeof STIMULUS_VERSION;

/**
 * Versions this package can validate at the Ingress boundary.
 * Anything outside this list must be rejected with `schema_invalid`; adding a
 * version is a contract change.
 */
export const SUPPORTED_STIMULUS_INPUT_VERSIONS = [STIMULUS_INPUT_VERSION] as const;

/** Semver of the contract surface itself (types + schemas), not of a build. */
export const CONTRACTS_VERSION = '1.1.0' as const;
