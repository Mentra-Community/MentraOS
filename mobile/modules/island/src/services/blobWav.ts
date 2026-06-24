/**
 * Pure helpers for BlobStore — WAV header assembly, little-endian encoders,
 * path-segment sanitization, and PCM level metering. No React Native / Expo /
 * native imports, so this is unit-testable in isolation (see blobWav.test.ts).
 */

/** Filesystem-safe path segment. Strips traversal + unsafe chars; never empty. */
export function sanitizeSegment(s: string): string {
  const cleaned = (s || "").replace(/[^A-Za-z0-9._-]/g, "_")
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_"
  return cleaned.slice(0, 120)
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

export function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

/** Build a 44-byte canonical PCM WAV header for a known dataSize (mono, 16-bit by default). */
export function buildWavHeader(sampleRate: number, dataBytes: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const h = new Uint8Array(44)
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const put = (bytes: Uint8Array, at: number) => h.set(bytes, at)
  ascii("RIFF", 0)
  put(u32le(36 + dataBytes), 4)
  ascii("WAVE", 8)
  ascii("fmt ", 12)
  put(u32le(16), 16)
  put(u16le(1), 20) // PCM
  put(u16le(channels), 22)
  put(u32le(sampleRate), 24)
  put(u32le(byteRate), 28)
  put(u16le(blockAlign), 32)
  put(u16le(bitsPerSample), 34)
  ascii("data", 36)
  put(u32le(dataBytes), 40)
  return h
}

/** Coarse 0–1 peak level from a PCM16-LE frame, for a live input meter. */
export function pcmPeakLevel(bytes: Uint8Array): number {
  let peak = 0
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let v = bytes[i] | (bytes[i + 1] << 8)
    if (v >= 0x8000) v -= 0x10000 // int16
    const a = Math.abs(v)
    if (a > peak) peak = a
  }
  return Math.min(1, peak / 32768)
}
