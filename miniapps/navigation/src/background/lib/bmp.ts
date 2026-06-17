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
 * Encode an 8-bit grayscale pixel buffer (row-major, top-down, 1 byte/px)
 * as a base64 8-bit BMP string. Uses a 256-entry grayscale palette so each
 * pixel byte indexes its own gray level (0 = black, 255 = white).
 */
export function encodeBmpBase64(gray: Uint8Array, width: number, height: number): string {
  if (gray.length !== width * height) {
    throw new Error(`encodeBmpBase64: expected ${width * height} bytes, got ${gray.length}`)
  }

  const GRAY_COLOR_TABLE = 256 * 4 // 256 colors * 4 bytes
  const grayPixelOffset = FILE_HEADER + DIB_HEADER + GRAY_COLOR_TABLE // 1078
  const rowSize = Math.ceil(width / 4) * 4 // 1 byte/px, 4-byte aligned
  const pixelDataSize = rowSize * height
  const fileSize = grayPixelOffset + pixelDataSize

  const buf = new Uint8Array(fileSize)

  // BMP file header (14 bytes)
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4d // 'M'
  setU32LE(buf, 2, fileSize)
  setU32LE(buf, 6, 0) // reserved
  setU32LE(buf, 10, grayPixelOffset)

  // DIB header (BITMAPINFOHEADER, 40 bytes)
  setU32LE(buf, 14, DIB_HEADER)
  setU32LE(buf, 18, width)
  setU32LE(buf, 22, height) // positive = bottom-up
  setU16LE(buf, 26, 1) // planes
  setU16LE(buf, 28, 8) // bits per pixel
  setU32LE(buf, 30, 0) // compression: BI_RGB (none)
  setU32LE(buf, 34, pixelDataSize)
  setU32LE(buf, 38, 2835) // X px/meter (~72 DPI)
  setU32LE(buf, 42, 2835) // Y px/meter
  setU32LE(buf, 46, 256) // colors used
  setU32LE(buf, 50, 256) // important colors

  // Grayscale palette (1024 bytes): entry i = gray level i (BGRA).
  for (let i = 0; i < 256; i++) {
    const off = FILE_HEADER + DIB_HEADER + i * 4
    buf[off] = i // B
    buf[off + 1] = i // G
    buf[off + 2] = i // R
    buf[off + 3] = 0x00 // reserved
  }

  // Pixel data — bottom-up rows, 1 byte/px.
  for (let y = 0; y < height; y++) {
    const srcRow = y * width // source is top-down
    const destRow = grayPixelOffset + (height - 1 - y) * rowSize // write bottom-up
    for (let x = 0; x < width; x++) {
      buf[destRow + x] = gray[srcRow + x]!
    }
  }
  return base64(buf)
}

/**
 * Build an 8-bit grayscale gradient test image as a base64 BMP. The width is
 * split into 17 equal vertical bars whose gray level steps 0 → 16 left to
 * right — handy for verifying the glasses' grayscale rendering.
 */
export function gradientTestImageBase64(width: number, height: number): string {
  const BARS = 255 // levels 0..16
  const gray = new Uint8Array(width * height)
  for (let x = 0; x < width; x++) {
    const level = Math.min(BARS - 1, Math.floor((x / width) * BARS))
    for (let y = 0; y < height; y++) {
      gray[y * width + x] = level
    }
  }
  return encodeBmpBase64(gray, width, height)
}

/**
 * Build an 8-bit grayscale test image of just the rectangle BORDER (outline)
 * as a base64 BMP — a white frame `thickness` px wide on a black background.
 * Handy for seeing the exact bounds/size of a bitmap container on the glasses.
 */
export function borderTestImageBase64(width: number, height: number, thickness = 2): string {
  const t = Math.max(1, Math.min(thickness, Math.floor(Math.min(width, height) / 2)))
  const gray = new Uint8Array(width * height) // 0 = black fill
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder = x < t || x >= width - t || y < t || y >= height - t
      if (onBorder) gray[y * width + x] = 255 // white edge
    }
  }
  return encodeBmpBase64(gray, width, height)
}

/* -------------------------------------------------------------------------- */
/* Minimal 5×7 bitmap font — enough to draw short uppercase test labels into a */
/* bitmap. Each glyph is 7 rows × 5 bits (MSB = leftmost column).             */

const GLYPH_W = 5
const GLYPH_H = 7
const GLYPH_GAP = 1 // blank column between glyphs

// Bit rows per glyph, top→bottom. 1 = on (white). Only the chars we need.
const FONT: Record<string, number[]> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
}

/** Width in px of a string rendered at `scale` (incl. inter-glyph gaps). */
function measureText(text: string, scale: number): number {
  const n = text.length
  if (n === 0) return 0
  return (n * GLYPH_W + (n - 1) * GLYPH_GAP) * scale
}

/** Blit a string into `gray` (8-bit, row-major) at top-left (ox, oy), `scale`×. */
function drawText(
  gray: Uint8Array,
  imgW: number,
  imgH: number,
  text: string,
  ox: number,
  oy: number,
  scale: number,
  value = 255,
): void {
  let penX = ox
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "]!
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row]!
      for (let col = 0; col < GLYPH_W; col++) {
        if ((bits >> (GLYPH_W - 1 - col)) & 1) {
          // Scale up each lit cell into a scale×scale block.
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = penX + col * scale + dx
              const py = oy + row * scale + dy
              if (px >= 0 && px < imgW && py >= 0 && py < imgH) gray[py * imgW + px] = value
            }
          }
        }
      }
    }
    penX += (GLYPH_W + GLYPH_GAP) * scale
  }
}

/**
 * Bordered box with `text` drawn centered inside it, as a base64 BMP. Same
 * white-frame-on-black look as [borderTestImageBase64], but with a label baked
 * into the bitmap (no separate positioned-text layout needed).
 */
export function labeledBoxImageBase64(
  width: number,
  height: number,
  text: string,
  thickness = 2,
): string {
  const t = Math.max(1, Math.min(thickness, Math.floor(Math.min(width, height) / 2)))
  const gray = new Uint8Array(width * height) // 0 = black fill
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onBorder = x < t || x >= width - t || y < t || y >= height - t
      if (onBorder) gray[y * width + x] = 255
    }
  }
  // Pick the largest integer scale that fits the text inside the border padding.
  const padX = t + 2
  const padY = t + 2
  const maxW = width - padX * 2
  const maxH = height - padY * 2
  let scale = Math.max(1, Math.floor(maxH / GLYPH_H))
  while (scale > 1 && measureText(text, scale) > maxW) scale--
  const tw = measureText(text, scale)
  const th = GLYPH_H * scale
  const ox = Math.round((width - tw) / 2)
  const oy = Math.round((height - th) / 2)
  drawText(gray, width, height, text, ox, oy, scale, 255)
  return encodeBmpBase64(gray, width, height)
}
