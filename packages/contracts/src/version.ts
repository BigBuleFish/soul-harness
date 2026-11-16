/**
 * Protocol version constants.
 *
 * Versioning is carried in-band (`schema` field on the envelope) rather than in
 * a transport header, so a captured stimulus is self-describing.
 */

/** The only stimulus envelope version accepted by this contract set. */
export const PROTOCOL_VERSION = 'soul.stimulus.v1' as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Versions this package can validate. Ingress must reject anything outside
 * this list with `schema_invalid`; adding a version is a contract change.
 */
export const SUPPORTED_STIMULUS_VERSIONS = [PROTOCOL_VERSION] as const;

/** Semver of the contract surface itself (types + schemas), not of a build. */
export const CONTRACTS_VERSION = '1.0.0' as const;
