/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  CALL_GAIN_SWEEP_STEP_MS,
  CallGainSweep,
  recommendCallGain,
  type CallGainSweepClock,
  type CallGainSweepPhaseSummary,
} from "../CallGainSweep"
import type {Pcm16Level} from "../../utils/pcm16"

function level(partial: Partial<Pcm16Level> & Pick<Pcm16Level, "meanAbs" | "peak">): Pcm16Level {
  return {
    samples: 16000,
    clipped: 0,
    nearClip: 0,
    ...partial,
  }
}

function harness() {
  const timeouts: Array<{fn: () => void; ms: number}> = []
  const applied: number[] = []
  const logs: unknown[][] = []
  const clock: CallGainSweepClock = {
    now: () => 0,
    setTimeout: (fn, ms) => {
      timeouts.push({fn, ms})
      return timeouts.length
    },
    clearTimeout: () => {
      timeouts.length = 0
    },
    log: (...args) => logs.push(args),
  }
  const sweep = new CallGainSweep(clock)
  return {
    sweep,
    applied,
    logs,
    timeouts,
    start: () => sweep.start((gain) => applied.push(gain)),
    flush: () => {
      const next = timeouts.shift()
      next?.fn()
    },
  }
}

function phase(partial: Partial<CallGainSweepPhaseSummary> & Pick<CallGainSweepPhaseSummary, "label" | "gain">) {
  return {
    db: 0,
    windows: 10,
    speechWindows: 8,
    quietWindows: 2,
    clippedWindows: 0,
    nearClipWindows: 0,
    speechMeanAbs: 4000,
    speechPeakMax: 20000,
    speechPeakPct: 61,
    speechClipPct: 0,
    speechNearClipPct: 0,
    samples: 160000,
    speechSamples: 128000,
    clipped: 0,
    nearClip: 0,
    ...partial,
  }
}

describe("recommendCallGain", () => {
  test("needs both 15 phases clean before it will keep +32 dB", () => {
    expect(
      recommendCallGain([
        phase({label: "15a", gain: 15}),
        phase({label: "14", gain: 14, speechClipPct: 2}),
        phase({label: "15b", gain: 15}),
        phase({label: "13", gain: 13}),
      ]).gain,
    ).toBe(15)
    expect(
      recommendCallGain([
        phase({label: "15a", gain: 15, speechClipPct: 3}),
        phase({label: "14", gain: 14}),
        phase({label: "15b", gain: 15}),
        phase({label: "13", gain: 13}),
      ]).gain,
    ).toBe(14)
    expect(
      recommendCallGain([
        phase({label: "15a", gain: 15, speechClipPct: 8}),
        phase({label: "14", gain: 14, speechClipPct: 3}),
        phase({label: "15b", gain: 15, speechClipPct: 6}),
        phase({label: "13", gain: 13}),
      ]).gain,
    ).toBe(13)
  })

  test("one quiet 15 phase is not enough evidence to keep 15", () => {
    expect(
      recommendCallGain([
        phase({label: "15a", gain: 15}),
        phase({label: "14", gain: 14}),
        phase({label: "15b", gain: 15, speechWindows: 0, speechSamples: 0}),
      ]).gain,
    ).toBe(14)
  })
})

describe("CallGainSweep", () => {
  test("walks 15 → 14 → 15 → 13 and does not restart itself", () => {
    const h = harness()
    expect(h.start()).toBe(true)
    expect(h.start()).toBe(false)
    expect(h.applied).toEqual([15])
    expect(h.timeouts[0]?.ms).toBe(CALL_GAIN_SWEEP_STEP_MS)

    h.flush()
    h.flush()
    h.flush()
    expect(h.applied).toEqual([15, 14, 15, 13])
    h.flush()
    expect(h.sweep.isActive()).toBe(false)
    expect(h.logs.some((line) => line[0] === "CALL_GAIN_SWEEP done")).toBe(true)
  })

  test("a late uplink window advances the phase when setTimeout never fires", () => {
    let now = 0
    const applied: number[] = []
    const sweep = new CallGainSweep({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => {},
      log: () => {},
    })
    sweep.start((gain) => applied.push(gain))
    sweep.ingest(level({meanAbs: 5000, peak: 20000}))
    expect(sweep.currentLabel()).toBe("15a")
    now = CALL_GAIN_SWEEP_STEP_MS
    sweep.ingest(level({meanAbs: 5000, peak: 20000}))
    expect(applied).toEqual([15, 14])
    expect(sweep.currentLabel()).toBe("14")
  })

  test("speech-gates clip percent so a quiet gap cannot wash out a rail", () => {
    const h = harness()
    h.start()
    h.sweep.ingest(level({meanAbs: 120, peak: 500}))
    h.sweep.ingest(level({meanAbs: 5000, peak: 32767, clipped: 800, nearClip: 2000}))
    h.flush()

    const phaseLog = h.logs.find((line) => line[0] === "CALL_GAIN_SWEEP phase-complete")
    expect(phaseLog?.[1]).toMatchObject({
      label: "15a",
      speechWindows: 1,
      quietWindows: 1,
      speechClipPct: 5,
      speechNearClipPct: 12.5,
      speechPeakMax: 32767,
    })
  })
})
