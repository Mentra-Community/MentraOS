// 4-bit grayscale BMP encoder for the Even G2 lens, plus tiny raster helpers.
//
// The G2 takes a standard Windows 4-bit (16-level grayscale) BMP, bottom-up,
// rows padded to 4 bytes, 2 pixels/byte (high nibble = left pixel). Pixel value
// is gray8>>4. Matches G2.kt build4BitBmp() exactly so the firmware renders it.

// A simple top-down grayscale frame (0=black .. 255=white).
export function frame(w, h, fill = 0) {
  return { w, h, data: new Uint8Array(w * h).fill(fill) }
}
export function px(f, x, y, gray) {
  if (x >= 0 && y >= 0 && x < f.w && y < f.h) f.data[y * f.w + x] = gray & 0xff
}
export function fillRect(f, x, y, w, h, gray) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(f, xx, yy, gray)
}
export function border(f, t, gray) {
  fillRect(f, 0, 0, f.w, t, gray)
  fillRect(f, 0, f.h - t, f.w, t, gray)
  fillRect(f, 0, 0, t, f.h, gray)
  fillRect(f, f.w - t, 0, t, f.h, gray)
}
export function line(f, x0, y0, x1, y1, gray) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx - dy, x = x0, y = y0
  for (;;) {
    px(f, x, y, gray)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx) { err += dx; y += sy }
  }
}
export function disc(f, cx, cy, r, gray) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) px(f, cx + x, cy + y, gray)
}

// A recognizable, obviously-not-text test pattern.
export function demoImage(w = 200, h = 100) {
  const f = frame(w, h, 0)
  border(f, 3, 255) // white frame
  line(f, 0, 0, w - 1, h - 1, 160) // diagonals
  line(f, w - 1, 0, 0, h - 1, 160)
  disc(f, (w / 2) | 0, (h / 2) | 0, Math.min(w, h) / 4, 255) // center blob
  disc(f, (w / 2) | 0, (h / 2) | 0, Math.min(w, h) / 8, 0) // donut hole
  return f
}

// Floyd-Steinberg dither a gray8 frame down to the 16 levels the G2 can show
// (multiples of 17). Without this, smooth gradients band into blocky steps.
export function ditherTo16(f) {
  const { w, h } = f
  const px = Float32Array.from(f.data)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = px[i]
      const lvl = Math.max(0, Math.min(15, Math.round(old / 17)))
      const nw = lvl * 17
      out[i] = nw
      const err = old - nw
      if (x + 1 < w) px[i + 1] += (err * 7) / 16
      if (y + 1 < h) {
        if (x > 0) px[i + w - 1] += (err * 3) / 16
        px[i + w] += (err * 5) / 16
        if (x + 1 < w) px[i + w + 1] += (err * 1) / 16
      }
    }
  }
  return { w, h, data: out }
}

// Atkinson dither (classic Mac look): diffuses only 6/8 of the error -> punchier
// contrast, less "noise crawl" than Floyd-Steinberg on low-res displays.
export function ditherAtkinson(f) {
  const { w, h } = f
  const px = Float32Array.from(f.data)
  const out = new Uint8Array(w * h)
  const spread = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const lvl = Math.max(0, Math.min(15, Math.round(px[i] / 17)))
      out[i] = lvl * 17
      const err = (px[i] - out[i]) / 8
      for (const [dx, dy] of spread) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny < h) px[ny * w + nx] += err
      }
    }
  }
  return { w, h, data: out }
}

// Ordered 4x4 Bayer dither: stable patterns (no frame-to-frame crawl), best for
// animation since pixels don't shimmer between frames.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
export function ditherBayer(f) {
  const { w, h } = f
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const t = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5 // -0.47..+0.47
      const lvl = Math.max(0, Math.min(15, Math.round(f.data[i] / 17 + t)))
      out[i] = lvl * 17
    }
  }
  return { w, h, data: out }
}

// Little-endian writers
function u32(n) { return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]) }
function u16(n) { return Buffer.from([n & 0xff, (n >> 8) & 0xff]) }

// Encode a grayscale frame to a 4-bit BMP Buffer.
export function encode4BitBmp(f) {
  const { w, h, data } = f
  const bytesPerRow = (w + 1) >> 1
  const padded = (bytesPerRow + 3) & ~3
  const pixelSize = padded * h
  const offset = 14 + 40 + 64
  const fileSize = offset + pixelSize

  const fileHeader = Buffer.concat([Buffer.from("BM"), u32(fileSize), u16(0), u16(0), u32(offset)])
  const dib = Buffer.concat([
    u32(40), u32(w), u32(h), u16(1), u16(4), u32(0), u32(pixelSize), u32(2835), u32(2835), u32(16), u32(0),
  ])
  const palette = Buffer.alloc(64)
  for (let i = 0; i < 16; i++) {
    const g = i * 17
    palette[i * 4] = g // B
    palette[i * 4 + 1] = g // G
    palette[i * 4 + 2] = g // R
    palette[i * 4 + 3] = 0
  }
  const pixels = Buffer.alloc(pixelSize)
  for (let row = 0; row < h; row++) {
    const srcY = h - 1 - row // BMP is bottom-up
    const base = row * padded
    for (let x = 0; x < w; x++) {
      const idx4 = (data[srcY * w + x] >> 4) & 0x0f
      const bytePos = base + (x >> 1)
      if ((x & 1) === 0) pixels[bytePos] |= idx4 << 4
      else pixels[bytePos] |= idx4
    }
  }
  return Buffer.concat([fileHeader, dib, palette, pixels])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bmp = encode4BitBmp(demoImage(200, 100))
  console.log(`demo 4-bit BMP: ${bmp.length} bytes, header "${bmp.subarray(0, 2)}", bpp ${bmp[28]}`)
}
