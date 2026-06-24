/**
 * WAV assembly helpers — pure, no SDK imports, so they're unit-testable.
 *
 * The Recorder builds the WAV container itself in the miniapp JSContext from the
 * PCM frames delivered by `session.mic.onAudioChunk`, then streams it to a blob.
 * The 44-byte header's size fields aren't known until the capture ends, so we
 * write a placeholder header first and patch the final header in at offset 0 on
 * stop (via BlobWriter.writeAt).
 */

export const WAV_HEADER_BYTES = 44

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
  const h = new Uint8Array(WAV_HEADER_BYTES)
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

/** ms of 16-bit mono PCM for `pcmBytes` at `sampleRate`. */
export function pcmDurationMs(pcmBytes: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0
  return Math.floor((pcmBytes / (sampleRate * 2)) * 1000)
}
