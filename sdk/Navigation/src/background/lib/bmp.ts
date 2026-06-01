/**
 * Minimal, dependency-free 1-bit BMP encoder for the background JSContext.
 *
 * The glasses render in 1-bit monochrome, and the phone decodes the
 * bitmap via iOS `UIImage(data:)` / Android BitmapFactory. A hand-rolled
 * stored-DEFLATE PNG is rejected by ImageIO ("could not decode image"),
 * and 24-bit is wasteful, so we emit an uncompressed 1-bit BMP — the same
 * shape the cloud SDK's bitmap-utils produces, which both platforms decode.
 *
 * BMP is bottom-up. 1-bit pixels are packed MSB-first, 8 px/byte, with a
 * 2-entry color table (index 0 = black, index 1 = white) and each row
 * padded to a 4-byte boundary.
 */

const FILE_HEADER = 14
const DIB_HEADER = 40
const COLOR_TABLE = 8 // 2 colors * 4 bytes
const PIXEL_OFFSET = FILE_HEADER + DIB_HEADER + COLOR_TABLE // 62

function setU16LE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
}

function setU32LE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
  buf[off + 2] = (v >>> 16) & 0xff
  buf[off + 3] = (v >>> 24) & 0xff
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

/**
 * Encode an 8-bit RGB pixel buffer (row-major, top-down, R,G,B per pixel)
 * as a base64 1-bit BMP string. A pixel is white (bit 1) when any channel
 * exceeds 128, else black (bit 0) — matching the cloud SDK's threshold.
 */
export function encodeBmpBase64(rgb: Uint8Array, width: number, height: number): string {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodeBmpBase64: expected ${width * height * 3} bytes, got ${rgb.length}`)
  }

  const rowSize = Math.ceil(width / 32) * 4 // 1 bit/px, 4-byte aligned
  const pixelDataSize = rowSize * height
  const fileSize = PIXEL_OFFSET + pixelDataSize

  const buf = new Uint8Array(fileSize)

  // BMP file header (14 bytes)
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4d // 'M'
  setU32LE(buf, 2, fileSize)
  setU32LE(buf, 6, 0) // reserved
  setU32LE(buf, 10, PIXEL_OFFSET)

  // DIB header (BITMAPINFOHEADER, 40 bytes)
  setU32LE(buf, 14, DIB_HEADER)
  setU32LE(buf, 18, width)
  setU32LE(buf, 22, height) // positive = bottom-up
  setU16LE(buf, 26, 1) // planes
  setU16LE(buf, 28, 1) // bits per pixel
  setU32LE(buf, 30, 0) // compression: BI_RGB (none)
  setU32LE(buf, 34, pixelDataSize)
  setU32LE(buf, 38, 2835) // X px/meter (~72 DPI)
  setU32LE(buf, 42, 2835) // Y px/meter
  setU32LE(buf, 46, 2) // colors used
  setU32LE(buf, 50, 2) // important colors

  // Color table (8 bytes): index 0 = black, index 1 = white (BGRA).
  // black = 00 00 00 00 (already zeroed)
  buf[58] = 0xff // B
  buf[59] = 0xff // G
  buf[60] = 0xff // R
  buf[61] = 0x00 // reserved

  // Pixel data — bottom-up rows, 1 bit/px MSB-first.
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 3 // source is top-down
    const destRow = PIXEL_OFFSET + (height - 1 - y) * rowSize // write bottom-up
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3
      const isWhite = rgb[s] > 128 || rgb[s + 1] > 128 || rgb[s + 2] > 128
      if (isWhite) {
        buf[destRow + (x >> 3)] |= 1 << (7 - (x & 7))
      }
    }
  }

  return base64(buf)
}
