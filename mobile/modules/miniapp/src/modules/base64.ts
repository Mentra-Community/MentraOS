/**
 * @fileoverview Dependency-free base64 codec for the miniapp background runtime.
 *
 * The background bundle runs in a per-miniapp JS engine (JavaScriptCore on iOS,
 * QuickJS on Android) where `Buffer`, `btoa`/`atob`, and Node APIs are NOT
 * guaranteed to exist. `session.blob` round-trips binary as base64 strings over
 * the JSON bridge, so it needs an encoder/decoder that works with nothing but
 * the language. This is that — standard RFC 4648 base64, no padding tricks.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Reverse lookup table: char code → 6-bit value (or -1). Built once. */
const LOOKUP: Int16Array = (() => {
  const t = new Int16Array(256).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i
  t["=".charCodeAt(0)] = 0
  return t
})()

/** Coerce a Uint8Array / ArrayBuffer / ArrayBufferView into a Uint8Array view (no copy when possible). */
export function toUint8Array(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

/** Encode bytes to a base64 string. */
export function bytesToBase64(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const len = bytes.length
  let out = ""
  let i = 0
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  const rem = len - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + "=="
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + "="
  }
  return out
}

/** Decode a base64 string to bytes. Ignores whitespace; tolerant of missing padding. */
export function base64ToBytes(b64: string): Uint8Array {
  // Count valid (non-whitespace) chars and trailing '=' to size the output exactly.
  let validChars = 0
  let pad = 0
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i)
    if (c === 0x3d) {
      pad++
      validChars++
    } else if (LOOKUP[c] !== -1) {
      validChars++
    }
  }
  const fullGroups = Math.floor(validChars / 4)
  const remChars = validChars - fullGroups * 4
  let outLen = fullGroups * 3 - (pad > 0 && remChars === 0 ? pad : 0)
  if (remChars === 2) outLen += 1
  else if (remChars === 3) outLen += 2
  if (outLen < 0) outLen = 0

  const out = new Uint8Array(outLen)
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < b64.length && o < outLen; i++) {
    const c = b64.charCodeAt(i)
    if (c === 0x3d) break // '=' — end of data
    const v = LOOKUP[c]
    if (v === -1) continue // skip whitespace / stray chars
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}
