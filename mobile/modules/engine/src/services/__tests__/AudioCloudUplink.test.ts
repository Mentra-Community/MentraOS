/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

let onLc3Frame: ((event: {lc3: number[]}) => void) | null = null
const remove = mock(() => {})
const addListener = mock((_event: string, listener: (event: {lc3: number[]}) => void) => {
  onLc3Frame = listener
  return {remove}
})
const sendAudioFrame = mock(() => {})

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {addListener},
}))

mock.module("../CloudClientService", () => ({
  cloudClientService: {
    hasAudioSubscriptions: () => true,
    isConnected: () => true,
    sendAudioFrame,
  },
}))

const {
  setAudioCloudUplinkSuppressed,
  startAudioCloudUplink,
  stopAudioCloudUplink,
} = require("../AudioCloudUplink")

describe("AudioCloudUplink playback suppression", () => {
  beforeEach(() => {
    stopAudioCloudUplink()
    addListener.mockClear()
    remove.mockClear()
    sendAudioFrame.mockClear()
    onLc3Frame = null
    startAudioCloudUplink()
  })

  test("keeps receiving LC3 but drops frames while phone audio is active", () => {
    onLc3Frame?.({lc3: [1, 2, 3]})
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    setAudioCloudUplinkSuppressed("url:tts", true)
    onLc3Frame?.({lc3: [4, 5, 6]})
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    setAudioCloudUplinkSuppressed("url:tts", false)
    onLc3Frame?.({lc3: [7, 8, 9]})
    expect(sendAudioFrame).toHaveBeenCalledTimes(2)
  })

  test("waits for every overlapping playback source to finish", () => {
    setAudioCloudUplinkSuppressed("url:tts", true)
    setAudioCloudUplinkSuppressed("stream:cue", true)
    setAudioCloudUplinkSuppressed("url:tts", false)
    onLc3Frame?.({lc3: [1]})
    expect(sendAudioFrame).not.toHaveBeenCalled()

    setAudioCloudUplinkSuppressed("stream:cue", false)
    onLc3Frame?.({lc3: [2]})
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)
  })
})
