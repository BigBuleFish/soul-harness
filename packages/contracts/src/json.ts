/**
 * Minimal JSON value model.
 *
 * The core contract never interprets extension payloads, so it needs exactly
 * one property from them: they must be JSON-serialisable. This type is used
 * only for that bound; no traversal helpers are provided on purpose.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };
