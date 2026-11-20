/**
 * Crockford Base32 body of a Harness identifier.
 *
 * IDENTITY-PROTOCOL §3.2, frozen:
 *   1. Unix milliseconds as 48 bits, big-endian, zero-padded at the high end
 *      to 50 bits, then 10 Crockford characters.
 *   2. 10 entropy bytes (80 bits), big-endian, then 16 characters.
 *
 * The 48-bit integer occupies the LOW 48 bits of that 50-bit field. The top
 * two bits stay 0, so the first character is always in `0-7`. Shifting the
 * timestamp up by two bits would be a different algorithm and is not done.
 *
 * The alphabet is the contracts constant, not a second copy. `node:crypto`
 * is intentionally not imported here: encoding is a pure function of the
 * numbers it is given.
 */

import { ID_ALPHABET } from '@soul-harness/contracts';

import { RuntimeError } from '../errors.js';

/** Random section of every allocated identifier. 80 bits, no framing bits. */
export const ID_ENTROPY_BYTES = 10;

const TIMESTAMP_CHARS = 10;
const RANDOM_CHARS = 16;
const CHAR_BITS = 5n;
const TIMESTAMP_WIDTH_BITS = BigInt(TIMESTAMP_CHARS) * CHAR_BITS;

function alphabetChar(index: number): string {
  const char = ID_ALPHABET.charAt(index);
  if (char.length !== 1) {
    throw new RuntimeError('id_encoding', 'identifier alphabet index is out of range');
  }
  return char;
}

/**
 * 10-character time prefix. `ms` must already be an integer in `0 .. 2^48-1`.
 */
export function encodeTimestamp(ms: number): string {
  const value = BigInt(ms);
  let out = '';
  for (let shift = TIMESTAMP_WIDTH_BITS - CHAR_BITS; shift >= 0n; shift -= CHAR_BITS) {
    out += alphabetChar(Number((value >> shift) & 31n));
  }
  if (out.length !== TIMESTAMP_CHARS) {
    throw new RuntimeError('id_encoding', 'timestamp did not encode to 10 characters');
  }
  return out;
}

/** 16-character entropy section. `bytes` must already be exactly 10 bytes long. */
export function encodeEntropy(bytes: Uint8Array): string {
  if (bytes.byteLength !== ID_ENTROPY_BYTES) {
    throw new RuntimeError('id_encoding', 'entropy must be 10 bytes');
  }

  // Leftover bits between bytes are at most 4, so the accumulator stays far
  // below the 32-bit signed range even after the next byte is shifted in.
  let acc = 0;
  let accBits = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    accBits += 8;
    while (accBits >= 5) {
      accBits -= 5;
      out += alphabetChar((acc >>> accBits) & 31);
    }
    acc &= (1 << accBits) - 1;
  }

  if (accBits !== 0 || out.length !== RANDOM_CHARS) {
    throw new RuntimeError('id_encoding', 'entropy did not encode to 16 characters');
  }
  return out;
}
