/**
 * UTF-8 helpers that do not depend on `TextEncoder`, which some background JS runtimes lack. A lone surrogate is
 * encoded as U+FFFD, exactly as `TextEncoder` does.
 */
import {createIncrementalSha256} from "../../utils/sha256"

/** The code point starting at `index` and how many UTF-16 units it spans. */
function codePointAt(value: string, index: number): {codePoint: number; units: 1 | 2} {
  const code = value.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
    const next = value.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      return {codePoint: 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00), units: 2}
    }
  }
  if (code >= 0xd800 && code <= 0xdfff) return {codePoint: 0xfffd, units: 1}
  return {codePoint: code, units: 1}
}

/** The number of bytes `value` occupies in UTF-8. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; ) {
    const {codePoint, units} = codePointAt(value, index)
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
    index += units
  }
  return bytes
}

/** `value` as UTF-8 bytes. */
export function utf8Encode(value: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(value))
  let offset = 0
  for (let index = 0; index < value.length; ) {
    const {codePoint, units} = codePointAt(value, index)
    index += units
    if (codePoint < 0x80) {
      out[offset++] = codePoint
    } else if (codePoint < 0x800) {
      out[offset++] = 0xc0 | (codePoint >> 6)
      out[offset++] = 0x80 | (codePoint & 0x3f)
    } else if (codePoint < 0x10000) {
      out[offset++] = 0xe0 | (codePoint >> 12)
      out[offset++] = 0x80 | ((codePoint >> 6) & 0x3f)
      out[offset++] = 0x80 | (codePoint & 0x3f)
    } else {
      out[offset++] = 0xf0 | (codePoint >> 18)
      out[offset++] = 0x80 | ((codePoint >> 12) & 0x3f)
      out[offset++] = 0x80 | ((codePoint >> 6) & 0x3f)
      out[offset++] = 0x80 | (codePoint & 0x3f)
    }
  }
  return out
}

/** The SHA-256 of `text` encoded as UTF-8, as lowercase hex. Synchronous: Hermes has no WebCrypto `subtle`. */
export function sha256HexOfText(text: string): string {
  const hash = createIncrementalSha256()
  hash.update(utf8Encode(text))
  return hash.digestHex()
}
