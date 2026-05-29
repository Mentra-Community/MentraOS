/**
 * Minimal, dependency-free PNG encoder for the background JSContext.
 *
 * The miniapp background bundle runs in a bare JS runtime (iOS JSC /
 * Android QuickJS) with no DOM, no <canvas>, and no zlib/DEFLATE. So we
 * build the PNG bytes by hand and skip compression entirely: the zlib
 * stream uses *stored* (uncompressed) DEFLATE blocks, which is fully
 * spec-compliant and decodes on every PNG reader (including the phone's
 * UIImage / BitmapFactory path that converts to the glasses' 1-bit BMP).
 *
 * Only what we need: 8-bit truecolor (RGB), filter type 0 (None), no
 * interlacing, no palette. At 100x100 the file is ~30KB — well under any
 * transport limit on session.display.showBitmapView.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ── CRC32 (PNG chunk checksum, poly 0xEDB88420) ───────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88420 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── Adler-32 (zlib stream checksum) ───────────────────────────────────
function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  const MOD = 65521
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % MOD
    b = (b + a) % MOD
  }
  return ((b << 16) | a) >>> 0
}

/** A growable byte sink with big-endian helpers. */
class ByteWriter {
  private buf: number[] = []

  u8(v: number): void {
    this.buf.push(v & 0xff)
  }

  u16be(v: number): void {
    this.buf.push((v >>> 8) & 0xff, v & 0xff)
  }

  u16le(v: number): void {
    this.buf.push(v & 0xff, (v >>> 8) & 0xff)
  }

  u32be(v: number): void {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  }

  bytes(arr: ArrayLike<number>): void {
    for (let i = 0; i < arr.length; i++) this.buf.push(arr[i] & 0xff)
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.buf)
  }
}

/** Wrap a chunk body in `len | type | data | crc` and append to `w`. */
function writeChunk(w: ByteWriter, type: string, data: Uint8Array): void {
  w.u32be(data.length)
  const typeBytes = Uint8Array.from([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ])
  // CRC covers the type + data.
  const crcInput = new Uint8Array(typeBytes.length + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, typeBytes.length)
  w.bytes(typeBytes)
  w.bytes(data)
  w.u32be(crc32(crcInput))
}

/** zlib stream wrapping `raw` in stored (uncompressed) DEFLATE blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const w = new ByteWriter()
  // zlib header: CMF=0x78 (deflate, 32K window), FLG=0x01 (no dict, check ok).
  w.u8(0x78)
  w.u8(0x01)
  const MAX = 0xffff
  let offset = 0
  while (offset < raw.length) {
    const len = Math.min(MAX, raw.length - offset)
    const isFinal = offset + len >= raw.length
    w.u8(isFinal ? 0x01 : 0x00) // BFINAL bit, BTYPE=00 (stored)
    w.u16le(len)
    w.u16le(~len & 0xffff) // NLEN = one's complement of LEN
    for (let i = 0; i < len; i++) w.u8(raw[offset + i])
    offset += len
  }
  w.u32be(adler32(raw))
  return w.toUint8Array()
}

function base64(bytes: Uint8Array): string {
  // Chunk the binary-string build so we don't blow the call stack on
  // String.fromCharCode(...big array) for ~30KB payloads.
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

/**
 * Encode an 8-bit RGB pixel buffer as a base64 PNG string.
 * `rgb` must be `width * height * 3` bytes (row-major, R,G,B per pixel).
 */
export function encodePngBase64(rgb: Uint8Array, width: number, height: number): string {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePngBase64: expected ${width * height * 3} bytes, got ${rgb.length}`)
  }

  // IHDR: width, height, bit depth 8, color type 2 (RGB), compression 0,
  // filter 0, interlace 0.
  const ihdr = new ByteWriter()
  ihdr.u32be(width)
  ihdr.u32be(height)
  ihdr.u8(8)
  ihdr.u8(2)
  ihdr.u8(0)
  ihdr.u8(0)
  ihdr.u8(0)

  // Raw image data = each scanline prefixed with a filter byte (0 = None).
  const stride = width * 3
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    raw[dst] = 0 // filter: None
    raw.set(rgb.subarray(y * stride, y * stride + stride), dst + 1)
  }

  const w = new ByteWriter()
  w.bytes(PNG_SIGNATURE)
  writeChunk(w, "IHDR", ihdr.toUint8Array())
  writeChunk(w, "IDAT", zlibStored(raw))
  writeChunk(w, "IEND", new Uint8Array(0))

  return base64(w.toUint8Array())
}
