/**
 * Level statistics for 16-bit little-endian mono PCM, as delivered by `mic_pcm`.
 *
 * Shared by the call uplink and the dev mic probe so both report the same number: a soak that
 * says `meanAbs=40` in one log and `meanAbs=40` in the other is measuring the same thing.
 */

/**
 * Hermes / the Expo bridge delivers `mic_pcm.pcm` as a Uint8Array, not an ArrayBuffer.
 * `new DataView(uint8Array)` throws `buffer must be an ArrayBuffer` — that is the redbox
 * attributed to whatever screen happens to be up (wifi scan, home, …).
 */
export function pcmDataView(frame: unknown): DataView | null {
  if (frame instanceof ArrayBuffer) {
    return new DataView(frame)
  }
  if (ArrayBuffer.isView(frame)) {
    try {
      return new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    } catch {
      const copy = Uint8Array.from(frame as unknown as ArrayLike<number>)
      return new DataView(copy.buffer)
    }
  }
  if (Array.isArray(frame)) {
    const copy = Uint8Array.from(frame)
    return new DataView(copy.buffer)
  }
  return null
}

export type Pcm16Level = {
  /** Mean absolute sample value (16-bit scale). ~30–60 is a quiet room on Mentra Live LC3. */
  meanAbs: number
  /** Largest absolute sample. */
  peak: number
  /** Samples counted. */
  samples: number
}

/** Level statistics over a batch of PCM16 frames. Unreadable frames are skipped, never thrown on. */
export function summarizePcm16(frames: unknown[]): Pcm16Level {
  let sum = 0
  let peak = 0
  let samples = 0
  for (const frame of frames) {
    const view = pcmDataView(frame)
    if (!view) continue
    const n = Math.floor(view.byteLength / 2)
    for (let i = 0; i < n; i++) {
      const v = Math.abs(view.getInt16(i * 2, true))
      sum += v
      if (v > peak) peak = v
    }
    samples += n
  }
  return {meanAbs: samples ? Math.round(sum / samples) : 0, peak, samples}
}

/**
 * Incremental accumulator for the same statistics, for hot paths that see one frame at a time
 * and report once a window (the call uplink logs every 5 s at 20 frames/s).
 */
export class Pcm16LevelMeter {
  private sum = 0
  private peakValue = 0
  private count = 0

  add(frame: unknown): void {
    const view = pcmDataView(frame)
    if (!view) return
    const n = Math.floor(view.byteLength / 2)
    for (let i = 0; i < n; i++) {
      const v = Math.abs(view.getInt16(i * 2, true))
      this.sum += v
      if (v > this.peakValue) this.peakValue = v
    }
    this.count += n
  }

  /** Read the window and start a new one. */
  take(): Pcm16Level {
    const level = {
      meanAbs: this.count ? Math.round(this.sum / this.count) : 0,
      peak: this.peakValue,
      samples: this.count,
    }
    this.sum = 0
    this.peakValue = 0
    this.count = 0
    return level
  }
}
