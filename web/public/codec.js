// Text <-> binary conversion, shared by the browser and the server.
//
// The encoding is a real, lossless UTF-8 bit encoding: every byte of the UTF-8
// representation of the text becomes exactly eight '0'/'1' characters, so
// decode(encode(text)) === text for any string, CJK and emoji included.

export const BITS_PER_BYTE = 8;

export class BinaryDecodeError extends Error {}

/** Encode text as a string of 0s and 1s (8-bit groups joined by `separator`). */
export function encode(text, separator = " ") {
  return Array.from(new TextEncoder().encode(text), (byte) =>
    byte.toString(2).padStart(BITS_PER_BYTE, "0"),
  ).join(separator);
}

/** Decode a string of 0s and 1s back into text. Whitespace is ignored. */
export function decode(bits) {
  const stripped = bits.replace(/\s+/g, "");
  if (stripped === "") return "";
  if (!/^[01]+$/.test(stripped)) {
    throw new BinaryDecodeError("input contains characters other than 0 and 1");
  }
  if (stripped.length % BITS_PER_BYTE !== 0) {
    throw new BinaryDecodeError(
      `bit length ${stripped.length} is not a multiple of ${BITS_PER_BYTE}`,
    );
  }
  const bytes = new Uint8Array(stripped.length / BITS_PER_BYTE);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(
      stripped.slice(i * BITS_PER_BYTE, (i + 1) * BITS_PER_BYTE),
      2,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new BinaryDecodeError(`bits are not valid UTF-8: ${cause.message}`);
  }
}

/** True if `text` is a well-formed binary message. */
export function looksLikeBinary(text) {
  const stripped = text.replace(/\s+/g, "");
  return (
    stripped.length > 0 &&
    /^[01]+$/.test(stripped) &&
    stripped.length % BITS_PER_BYTE === 0
  );
}
