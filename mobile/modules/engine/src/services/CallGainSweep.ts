/**
 * Timed A/B/A/C gain comparison for a live voice call.
 *
 * Mentra Live's last ADC step is +32 dB (index 15); the step below is +26 dB
 * (14), then 2 dB per index. Close-talk clips at 15 and still rails at 14, so
 * a call has to be measured at 15 → 14 → 15 → 13 on the same voice, not by
 * swapping phones or days.
 *
 * Production policy stays in micPolicy. This object only writes a temporary
 * override and logs speech-gated clip stats so a human can pick the index.
 */

import {PCM16_FULL_SCALE, pcm16WindowStats, type Pcm16Level} from "../utils/pcm16"

const LOG_TAG = "CALL_GAIN_SWEEP"

/** codec_adc_vol[] dB, same table as Super Mode. */
const GAIN_DB = [-99, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 32]

export const CALL_GAIN_SWEEP_STEPS = [
  {gain: 15, label: "15a"},
  {gain: 14, label: "14"},
  {gain: 15, label: "15b"},
  {gain: 13, label: "13"},
] as const

export const CALL_GAIN_SWEEP_STEP_MS = 25_000
/** Quiet room on this path is meanAbs ≈ 90–120. Talk starts well above this. */
export const CALL_GAIN_SWEEP_SPEECH_MEAN_ABS = 400

export type CallGainSweepStep = (typeof CALL_GAIN_SWEEP_STEPS)[number]

export type CallGainSweepPhaseSummary = {
  label: string
  gain: number
  db: number
  windows: number
  speechWindows: number
  quietWindows: number
  clippedWindows: number
  nearClipWindows: number
  speechMeanAbs: number
  speechPeakMax: number
  speechPeakPct: number
  speechClipPct: number
  speechNearClipPct: number
  samples: number
  speechSamples: number
  clipped: number
  nearClip: number
}

export type CallGainSweepRecommendation = {
  gain: number
  reason: string
}

export type CallGainSweepClock = {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  log: (...args: unknown[]) => void
}

type PhaseBucket = {
  step: CallGainSweepStep
  windows: number
  speechWindows: number
  quietWindows: number
  clippedWindows: number
  nearClipWindows: number
  speechMeanAbsSum: number
  speechPeakMax: number
  samples: number
  speechSamples: number
  clipped: number
  nearClip: number
  speechClipped: number
  speechNearClip: number
}

const defaultClock = (): CallGainSweepClock => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  log: (...args) => console.log(...args),
})

export function gainDb(index: number): number {
  return GAIN_DB[index] ?? Number.NaN
}

/**
 * Highest gain whose speech windows stay under the clip lines.
 *
 * Clip is the failure (rail = 32767). Near-clip at 30000 is the warning that
 * the next syllable will hit the rail. 15 is only legal if both 15a and 15b
 * agree; otherwise a loud stretch on one of them was luck.
 */
export function recommendCallGain(phases: readonly CallGainSweepPhaseSummary[]): CallGainSweepRecommendation {
  const speech = phases.filter((p) => p.speechWindows > 0)
  if (speech.length === 0) {
    return {gain: 13, reason: "no speech windows; stay at 13 until the sweep is talked through"}
  }

  const fifteen = speech.filter((p) => p.gain === 15)
  const fourteen = speech.find((p) => p.gain === 14)
  const thirteen = speech.find((p) => p.gain === 13)

  const clean = (p: CallGainSweepPhaseSummary) => p.speechClipPct < 0.5 && p.speechNearClipPct < 5
  const fifteenClean = fifteen.length >= 2 && fifteen.every(clean)
  if (fifteenClean) return {gain: 15, reason: "both 15 phases stayed under 0.5% clip / 5% near-clip"}
  if (fourteen && clean(fourteen)) {
    return {gain: 14, reason: "15 clips; 14 stayed under 0.5% clip / 5% near-clip"}
  }
  if (thirteen && clean(thirteen)) {
    return {gain: 13, reason: "15 and 14 clip; 13 stayed under 0.5% clip / 5% near-clip"}
  }
  return {gain: 13, reason: "every measured step still clipped; 13 is the floor of this sweep"}
}

function emptyBucket(step: CallGainSweepStep): PhaseBucket {
  return {
    step,
    windows: 0,
    speechWindows: 0,
    quietWindows: 0,
    clippedWindows: 0,
    nearClipWindows: 0,
    speechMeanAbsSum: 0,
    speechPeakMax: 0,
    samples: 0,
    speechSamples: 0,
    clipped: 0,
    nearClip: 0,
    speechClipped: 0,
    speechNearClip: 0,
  }
}

function summarizeBucket(bucket: PhaseBucket): CallGainSweepPhaseSummary {
  const speechClipPct =
    bucket.speechSamples > 0 ? Math.round((bucket.speechClipped / bucket.speechSamples) * 1000) / 10 : 0
  const speechNearClipPct =
    bucket.speechSamples > 0 ? Math.round((bucket.speechNearClip / bucket.speechSamples) * 1000) / 10 : 0
  return {
    label: bucket.step.label,
    gain: bucket.step.gain,
    db: gainDb(bucket.step.gain),
    windows: bucket.windows,
    speechWindows: bucket.speechWindows,
    quietWindows: bucket.quietWindows,
    clippedWindows: bucket.clippedWindows,
    nearClipWindows: bucket.nearClipWindows,
    speechMeanAbs:
      bucket.speechWindows > 0 ? Math.round(bucket.speechMeanAbsSum / bucket.speechWindows) : 0,
    speechPeakMax: bucket.speechPeakMax,
    speechPeakPct: Math.round((bucket.speechPeakMax / PCM16_FULL_SCALE) * 1000) / 10,
    speechClipPct,
    speechNearClipPct,
    samples: bucket.samples,
    speechSamples: bucket.speechSamples,
    clipped: bucket.clipped,
    nearClip: bucket.nearClip,
  }
}

export class CallGainSweep {
  private readonly clock: CallGainSweepClock
  private applyGain: ((gain: number) => void) | null = null
  private onDone: (() => void) | null = null
  private index = -1
  private timer: unknown = null
  private enteredAt = 0
  private bucket: PhaseBucket | null = null
  private readonly finished: CallGainSweepPhaseSummary[] = []

  constructor(clock: CallGainSweepClock = defaultClock()) {
    this.clock = clock
  }

  isActive(): boolean {
    return this.index >= 0
  }

  currentGain(): number | null {
    return this.index >= 0 ? CALL_GAIN_SWEEP_STEPS[this.index].gain : null
  }

  currentLabel(): string | null {
    return this.index >= 0 ? CALL_GAIN_SWEEP_STEPS[this.index].label : null
  }

  /**
   * Begin the 15 → 14 → 15 → 13 walk.
   * Returns false when a sweep is already mid-phase so a recompute cannot reset the clock.
   */
  start(applyGain: (gain: number) => void, onDone?: () => void): boolean {
    if (this.isActive()) return false
    this.applyGain = applyGain
    this.onDone = onDone ?? null
    this.finished.length = 0
    this.enter(0)
    return true
  }

  /** Super Mode / explicit re-run. Aborts the current phase if one is live. */
  restart(applyGain: (gain: number) => void, onDone?: () => void): boolean {
    if (this.isActive()) this.stop("restart")
    return this.start(applyGain, onDone)
  }

  stop(reason: string): void {
    if (!this.isActive() && this.timer == null) return
    this.closePhase("aborted")
    this.clearTimer()
    this.clock.log(`${LOG_TAG} stop`, {reason, phases: this.finished.slice()})
    this.index = -1
    this.bucket = null
    this.applyGain = null
    this.onDone = null
  }

  ingest(level: Pcm16Level): void {
    if (!this.bucket) return
    const stats = pcm16WindowStats(level)
    const speech = level.meanAbs >= CALL_GAIN_SWEEP_SPEECH_MEAN_ABS
    this.bucket.windows++
    this.bucket.samples += level.samples
    this.bucket.clipped += level.clipped
    this.bucket.nearClip += level.nearClip
    if (speech) {
      this.bucket.speechWindows++
      this.bucket.speechSamples += level.samples
      this.bucket.speechClipped += level.clipped
      this.bucket.speechNearClip += level.nearClip
      this.bucket.speechMeanAbsSum += level.meanAbs
      if (level.peak > this.bucket.speechPeakMax) this.bucket.speechPeakMax = level.peak
    } else {
      this.bucket.quietWindows++
    }
    if (level.clipped > 0) this.bucket.clippedWindows++
    if (level.nearClip > 0) this.bucket.nearClipWindows++

    this.clock.log(`${LOG_TAG} window`, {
      label: this.bucket.step.label,
      gain: this.bucket.step.gain,
      db: gainDb(this.bucket.step.gain),
      speech,
      meanAbs: stats.meanAbs,
      peak: stats.peak,
      peakPct: stats.peakPct,
      clipped: stats.clipped,
      clipPct: stats.clipPct,
      nearClip: stats.nearClip,
      nearClipPct: stats.nearClipPct,
      samples: stats.samples,
    })
    // RN pauses setTimeout while Mentra is behind Mentra Call. The ACS
    // uplink still delivers 1 s windows, so the hold is measured here.
    if (this.clock.now() - this.enteredAt >= CALL_GAIN_SWEEP_STEP_MS) this.advance()
  }

  private enter(index: number): void {
    this.index = index
    const step = CALL_GAIN_SWEEP_STEPS[index]
    this.bucket = emptyBucket(step)
    this.enteredAt = this.clock.now()
    this.applyGain?.(step.gain)
    this.clock.log(`${LOG_TAG} phase-start`, {
      label: step.label,
      gain: step.gain,
      db: gainDb(step.gain),
      holdMs: CALL_GAIN_SWEEP_STEP_MS,
      remaining: CALL_GAIN_SWEEP_STEPS.length - index,
    })
    this.timer = this.clock.setTimeout(() => this.advance(), CALL_GAIN_SWEEP_STEP_MS)
  }

  private advance(): void {
    this.timer = null
    this.closePhase("complete")
    const next = this.index + 1
    if (next >= CALL_GAIN_SWEEP_STEPS.length) {
      const pick = recommendCallGain(this.finished)
      this.clock.log(`${LOG_TAG} done`, {phases: this.finished.slice(), pick})
      this.index = -1
      this.bucket = null
      const done = this.onDone
      this.applyGain = null
      this.onDone = null
      done?.()
      return
    }
    this.enter(next)
  }

  private closePhase(how: "complete" | "aborted"): void {
    if (!this.bucket || this.bucket.windows === 0) return
    const summary = summarizeBucket(this.bucket)
    this.finished.push(summary)
    this.clock.log(`${LOG_TAG} phase-${how}`, summary)
    this.bucket = null
  }

  private clearTimer(): void {
    if (this.timer == null) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }
}

const sharedSweep = new CallGainSweep()

/** Process-wide sweep. MicSessionManager writes it; the ACS uplink meters it. */
export function getCallGainSweep(): CallGainSweep {
  return sharedSweep
}
