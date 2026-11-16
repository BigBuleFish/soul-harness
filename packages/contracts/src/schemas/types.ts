/**
 * Minimal JSON Schema typing.
 *
 * Schemas are authored as plain objects (draft-07) rather than loaded from
 * `.json` files: the package performs no IO, and a JSON import would add a
 * loader dependency and a build step for no benefit. Consumers hand these
 * objects straight to a validator (ajv, or any draft-07 implementation).
 */

export type JsonSchema = Readonly<Record<string, unknown>>;
