/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MIC_USE_CASE_PROFILES, resolveMicPolicy, type MicSessionSpec} from "../micPolicy"

const ANDROID = {glassesPcmUplink: true}
const IOS = {glassesPcmUplink: false}

const session = (useCase: MicSessionSpec["useCase"], source: MicSessionSpec["source"]): MicSessionSpec => ({
  useCase,
  source,
})

describe("resolveMicPolicy", () => {
  test("no sessions claims nothing", () => {
    expect(resolveMicPolicy([], ANDROID)).toEqual({rawPcm: false, pinGlasses: false, micTuning: null})
  })

  test("a glasses voice call claims PCM, pins, and applies the call gain", () => {
    expect(resolveMicPolicy([session("voice_call", "glasses")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: true,
      micTuning: {gain: 13},
    })
  })

  test("a phone session claims PCM but never pins and carries no glasses tuning", () => {
    expect(resolveMicPolicy([session("diagnostic", "phone")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: false,
      micTuning: null,
    })
  })

  test("a diagnostic run measures the gain users actually get", () => {
    expect(resolveMicPolicy([session("diagnostic", "glasses")], ANDROID)).toEqual({
      rawPcm: true,
      pinGlasses: true,
      micTuning: null,
    })
  })

  test("the lowest gain wins, because clipping is the irreversible failure", () => {
    const profiles = {...MIC_USE_CASE_PROFILES}
    expect(profiles.voice_call.gain).toBe(13)
    const resolved = resolveMicPolicy(
      [session("voice_call", "glasses"), session("transcription", "glasses")],
      ANDROID,
    )
    expect(resolved.micTuning).toEqual({gain: 13})
  })

  test("a captions subscriber alongside a call still runs at the call's gain", () => {
    const resolved = resolveMicPolicy(
      [session("transcription", "glasses"), session("voice_call", "glasses")],
      ANDROID,
    )
    expect(resolved).toEqual({rawPcm: true, pinGlasses: true, micTuning: {gain: 13}})
  })

  test("without a glasses PCM uplink a glasses lease has no hardware effect", () => {
    // iOS: the wearer's voice does not reach the call through the BES BLE path, so switching on
    // an LC3 stream nobody consumes would cost battery for nothing.
    expect(resolveMicPolicy([session("voice_call", "glasses")], IOS)).toEqual({
      rawPcm: false,
      pinGlasses: false,
      micTuning: null,
    })
  })

  test("a phone session still works where the glasses uplink does not", () => {
    expect(resolveMicPolicy([session("diagnostic", "phone")], IOS)).toEqual({
      rawPcm: true,
      pinGlasses: false,
      micTuning: null,
    })
  })
})
