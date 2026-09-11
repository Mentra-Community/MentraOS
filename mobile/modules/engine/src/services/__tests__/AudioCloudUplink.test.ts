/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {
  addAudioListener,
  emitLc3Frame,
  removeAudioListener,
  resetAudioTestMocks,
  sendAudioFrame,
} from "./audioTestMocks"

const {setAudioCloudUplinkSuppressed, startAudioCloudUplink, stopAudioCloudUplink} = require("../AudioCloudUplink")

describe("AudioCloudUplink playback suppression", () => {
  beforeEach(() => {
    stopAudioCloudUplink()
    resetAudioTestMocks()
    startAudioCloudUplink()
  })

  test("keeps receiving LC3 but drops frames while phone audio is active", () => {
    emitLc3Frame([1, 2, 3])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    setAudioCloudUplinkSuppressed("url:tts", true)
    emitLc3Frame([4, 5, 6])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    setAudioCloudUplinkSuppressed("url:tts", false)
    emitLc3Frame([7, 8, 9])
    expect(sendAudioFrame).toHaveBeenCalledTimes(2)
  })

  test("waits for every overlapping playback source to finish", () => {
    setAudioCloudUplinkSuppressed("url:tts", true)
    setAudioCloudUplinkSuppressed("stream:cue", true)
    setAudioCloudUplinkSuppressed("url:tts", false)
    emitLc3Frame([1])
    expect(sendAudioFrame).not.toHaveBeenCalled()

    setAudioCloudUplinkSuppressed("stream:cue", false)
    emitLc3Frame([2])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)
  })

  test("starts and stops one shared native listener", () => {
    expect(addAudioListener).toHaveBeenCalledTimes(1)
    stopAudioCloudUplink()
    expect(removeAudioListener).toHaveBeenCalledTimes(1)
  })
})
