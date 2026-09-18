/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  GAIN_DB,
  MIC_TUNING_FIRMWARE_DEFAULTS,
  MIC_USE_CASE_PROFILES,
  resolveMicPolicy,
  scaleMicTuningToGain,
  type MicSessionSpec,
} from "../micPolicy"

const ANDROID = {glassesPcmUplink: true}
const IOS = {glassesPcmUplink: false}

/** The call profile, restated here so a silent change to the index is visible in the diff. */
const CALL_TUNING = {gain: 13, open: 537, close: 376, sp_open: 1155, sp_close: 637}

const session = (useCase: MicSessionSpec["useCase"], source: MicSessionSpec["source"]): MicSessionSpec => ({
  useCase,
  source,
})

describe("scaleMicTuningToGain", () => {
  test("the shipped gain reproduces the firmware's own numbers", () => {
    expect(scaleMicTuningToGain(MIC_TUNING_FIRMWARE_DEFAULTS.gain)).toEqual({
      ...MIC_TUNING_FIRMWARE_DEFAULTS,
    })
  })

  /**
   * The gate compares post-gain RMS. -8 dB of gain against thresholds chosen for +32 dB is how a
   * Barrier that was meant to suppress speaker leak ends up suppressing the wearer instead.
   */
  test("thresholds fall with the gain so the acoustic trip point holds", () => {
    const scaled = scaleMicTuningToGain(13)
    const factor = Math.pow(10, (GAIN_DB[13]! - GAIN_DB[15]!) / 20)
    expect(scaled).toEqual(CALL_TUNING)
    expect(scaled.open).toBe(Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.open * factor))
    expect(scaled.sp_open).toBe(Math.round(MIC_TUNING_FIRMWARE_DEFAULTS.sp_open * factor))
    // Speaker-elevated still sits above normal, which is the whole point of the pair.
    expect(scaled.sp_open).toBeGreaterThan(scaled.open)
  })

  test("an out-of-range index is clamped rather than producing a silent gate", () => {
    expect(scaleMicTuningToGain(0).gain).toBe(1)
    expect(scaleMicTuningToGain(99).gain).toBe(15)
  })
})

describe("resolveMicPolicy", () => {
  test("no sessions claims nothing", () => {
    expect(resolveMicPolicy([], ANDROID)).toEqual({
      rawPcm: false,
      pinGlasses: false,
      micTuning: null,
      loudnessGate: null,
    })
  })

  test("a glasses voice call claims PCM, pins, applies the call gain and runs Barrier", () => {
    expect(resolveMicPolicy([session("voice_call", "glasses")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: true,
      micTuning: CALL_TUNING,
      loudnessGate: true,
    })
  })

  test("a phone session claims PCM but never pins and carries no glasses tuning", () => {
    expect(resolveMicPolicy([session("diagnostic", "phone")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: false,
      micTuning: null,
      loudnessGate: null,
    })
  })

  test("a diagnostic run measures the gain users actually get, ungated", () => {
    expect(resolveMicPolicy([session("diagnostic", "glasses")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: true,
      micTuning: null,
      loudnessGate: false,
    })
  })

  test("the lowest gain wins, because clipping is the irreversible failure", () => {
    expect(MIC_USE_CASE_PROFILES.voice_call.gain).toBe(13)
    const resolved = resolveMicPolicy(
      [session("voice_call", "glasses"), session("transcription", "glasses")],
      ANDROID,
    )
    expect(resolved.micTuning).toEqual(CALL_TUNING)
  })

  /** The winning profile travels whole: its thresholds only mean anything at its own gain. */
  test("a captions subscriber alongside a call still runs at the call's gain", () => {
    const resolved = resolveMicPolicy(
      [session("transcription", "glasses"), session("voice_call", "glasses")],
      ANDROID,
    )
    expect(resolved).toEqual({
      rawPcm: true,
      pinGlasses: true,
      micTuning: CALL_TUNING,
      loudnessGate: true,
    })
  })

  test("without a glasses PCM uplink a glasses lease has no hardware effect", () => {
    // iOS: the wearer's voice does not reach the call through the BES BLE path, so switching on
    // an LC3 stream nobody consumes would cost battery for nothing.
    expect(resolveMicPolicy([session("voice_call", "glasses")], IOS)).toEqual({
      rawPcm: false,
      pinGlasses: false,
      micTuning: null,
      loudnessGate: null,
    })
  })

  test("a phone session still works where the glasses uplink does not", () => {
    expect(resolveMicPolicy([session("diagnostic", "phone")], IOS)).toEqual({
      rawPcm: true,
      pinGlasses: false,
      micTuning: null,
      loudnessGate: null,
    })
  })
})
