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

/**
 * Build a 44-byte canonical PCM WAV header for a known dataSize (mono, 16-bit by
 * default).
 *
 * `trailerBytes` is the byte length of any chunk appended AFTER the `data` chunk
 * (e.g. a LIST/INFO metadata chunk — see {@link buildInfoChunk}). It's folded
 * into the RIFF chunk size so the file is well-formed, but it does NOT change the
 * `data` chunk size (the audio is still exactly `dataBytes`). Pass 0 (default)
 * for a header with no trailing chunks.
 */
export function buildWavHeader(
  sampleRate: number,
  dataBytes: number,
  channels = 1,
  bitsPerSample = 16,
  trailerBytes = 0,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const h = new Uint8Array(WAV_HEADER_BYTES)
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const put = (bytes: Uint8Array, at: number) => h.set(bytes, at)
  ascii("RIFF", 0)
  // RIFF size = everything after this field: 4 ("WAVE") + 24 (fmt chunk) + 8
  // (data chunk header) + dataBytes + any appended trailer chunk = 36 + data + trailer.
  put(u32le(36 + dataBytes + trailerBytes), 4)
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

/** Human-readable tags written into a WAV's LIST/INFO chunk. */
export interface WavTags {
  /** INAM — title. */
  title?: string
  /** IART — artist / source. */
  artist?: string
  /** ISFT — software that produced the file. */
  software?: string
  /** ICRD — creation date (free-form; we use YYYY-MM-DD). */
  date?: string
  /** ICMT — comment. */
  comment?: string
}

/**
 * Build a RIFF `LIST`/`INFO` chunk carrying human-readable tags (title, artist,
 * etc.). Players that read WAV metadata (Music, Files, ffmpeg, …) surface these,
 * so e.g. setting `artist` stops them showing "Unknown Artist". Returns an empty
 * array when no tags are provided.
 *
 * Layout: `"LIST" <u32le listSize> "INFO"` then, per tag,
 * `<4-byte id><u32le size><NUL-terminated ascii><pad to even>`. `size` includes
 * the trailing NUL but not the even-padding byte (per the RIFF spec).
 *
 * This chunk is appended AFTER the `data` chunk; pass its `.length` as
 * `trailerBytes` to {@link buildWavHeader} so the RIFF size stays correct.
 */
export function buildInfoChunk(tags: WavTags): Uint8Array {
  const fields: Array<[string, string | undefined]> = [
    ["INAM", tags.title],
    ["IART", tags.artist],
    ["ISFT", tags.software],
    ["ICRD", tags.date],
    ["ICMT", tags.comment],
  ]

  // Encode each present, non-empty tag into a sub-chunk.
  const subChunks: Uint8Array[] = []
  for (const [id, value] of fields) {
    if (!value || !value.trim()) continue
    // Latin-1 / ASCII body + trailing NUL. Non-ASCII bytes are masked to 8 bits;
    // tags are short labels/dates so this is fine for the common case.
    const body = value
    const payloadLen = body.length + 1 // +1 for NUL terminator
    const padded = payloadLen + (payloadLen % 2) // pad to even per RIFF
    const sub = new Uint8Array(8 + padded)
    for (let i = 0; i < 4; i++) sub[i] = id.charCodeAt(i)
    sub.set(u32le(payloadLen), 4)
    for (let i = 0; i < body.length; i++) sub[8 + i] = body.charCodeAt(i) & 0xff
    // sub[8 + body.length] is the NUL terminator (already 0); padding byte is 0 too.
    subChunks.push(sub)
  }
  if (subChunks.length === 0) return new Uint8Array(0)

  const subTotal = subChunks.reduce((n, c) => n + c.length, 0)
  const listSize = 4 + subTotal // "INFO" + sub-chunks
  const out = new Uint8Array(8 + listSize)
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii("LIST", 0)
  out.set(u32le(listSize), 4)
  ascii("INFO", 8)
  let at = 12
  for (const c of subChunks) {
    out.set(c, at)
    at += c.length
  }
  return out
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
