/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

const pcmStreamOpen = mock(async () => {})
const pcmStreamWrite = mock(async () => ({bufferedMs: 120}))
const pcmStreamClose = mock(async () => ({durationMs: 1_500}))
const pcmStreamAbort = mock(async () => {})
const setOwnAppAudioPlaying = mock(async () => {})
const setAudioModeAsync = mock(async () => {})
const setAudioCloudUplinkSuppressed = mock(() => {})

mock.module("../AudioCloudUplink", () => ({
  setAudioCloudUplinkSuppressed,
}))

mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {
    getGlassesMediaVolume: mock(async () => ({level: 10, statusCode: 0})),
    pcmStreamAbort,
    pcmStreamClose,
    pcmStreamOpen,
    pcmStreamWrite,
    setGlassesMediaVolume: mock(async () => ({level: 10, statusCode: 0})),
    setOwnAppAudioPlaying,
  },
}))

const audioPlayer = {
  addListener: mock(() => ({remove: () => {}})),
  pause: mock(() => {}),
  play: mock(() => {}),
  remove: mock(() => {}),
  replace: mock(() => {}),
  volume: 1,
}

mock.module("expo-audio", () => ({
  createAudioPlayer: () => audioPlayer,
  setAudioModeAsync,
}))

mock.module("react-native", () => ({
  Platform: {OS: "android"},
}))

mock.module("../../utils/timers", () => ({
  BgTimer: {
    clearTimeout: () => {},
    setTimeout: (callback: () => void) => {
      callback()
      return 1
    },
  },
}))

const audioPlaybackService = require("../AudioPlaybackService").default

describe("AudioPlaybackService live PCM streams", () => {
  beforeEach(async () => {
    await audioPlaybackService.stopAll()
    pcmStreamAbort.mockClear()
    pcmStreamClose.mockClear()
    pcmStreamOpen.mockClear()
    pcmStreamWrite.mockClear()
    setOwnAppAudioPlaying.mockClear()
    setAudioCloudUplinkSuppressed.mockClear()
    setAudioModeAsync.mockClear()
    setAudioModeAsync.mockImplementation(async () => {})
    audioPlayer.pause.mockClear()
    audioPlayer.play.mockClear()
    audioPlayer.replace.mockClear()
  })

  afterEach(async () => {
    await audioPlaybackService.stopAll()
  })

  test("prewarms a cold Android route by aborting silence before URL playback", async () => {
    await audioPlaybackService.play({audioUrl: "https://example.test/click.wav", requestId: "click"}, () => {})

    expect(pcmStreamOpen).toHaveBeenCalledTimes(1)
    expect(pcmStreamWrite).toHaveBeenCalledTimes(1)
    expect(pcmStreamAbort).toHaveBeenCalledTimes(1)
    expect(pcmStreamClose).not.toHaveBeenCalled()
    expect(audioPlayer.play).toHaveBeenCalledTimes(1)
  })

  test("opens, writes, drains, and reports active stream state", async () => {
    const onEnded = mock(() => {})

    await audioPlaybackService.openStream({
      appId: "com.example.call",
      channels: 1,
      onEnded,
      sampleRate: 24_000,
      streamId: "stream-1",
      volume: 0.75,
    })

    expect(pcmStreamOpen).toHaveBeenCalledWith("stream-1", 24_000, 1, 0.75)
    expect(setAudioCloudUplinkSuppressed).not.toHaveBeenCalled()
    expect(audioPlaybackService.isPlaying()).toBe(true)
    expect(audioPlaybackService.getActiveAppIds()).toEqual(["com.example.call"])
    expect(audioPlaybackService.getActiveCount()).toBe(1)

    await expect(audioPlaybackService.writeStreamChunk("stream-1", "AAAA")).resolves.toEqual({bufferedMs: 120})
    await expect(audioPlaybackService.closeStream("stream-1")).resolves.toEqual({durationMs: 1_500})

    expect(pcmStreamWrite).toHaveBeenCalledWith("stream-1", "AAAA")
    expect(pcmStreamClose).toHaveBeenCalledWith("stream-1")
    expect(onEnded).toHaveBeenCalledWith("stream-1", true, null, 1_500)
    expect(setAudioCloudUplinkSuppressed).not.toHaveBeenCalled()
    expect(audioPlaybackService.isPlaying()).toBe(false)
  })

  test("opening stopOtherAudio stream aborts the previous stream exactly once", async () => {
    const firstEnded = mock(() => {})
    await audioPlaybackService.openStream({
      appId: "app-one",
      channels: 1,
      onEnded: firstEnded,
      sampleRate: 16_000,
      streamId: "first",
    })

    await audioPlaybackService.openStream({
      appId: "app-two",
      channels: 1,
      onEnded: () => {},
      sampleRate: 16_000,
      stopOtherAudio: true,
      streamId: "second",
    })

    expect(pcmStreamAbort).toHaveBeenCalledWith("first")
    expect(firstEnded).toHaveBeenCalledTimes(1)
    expect(audioPlaybackService.getActiveAppIds()).toEqual(["app-two"])
  })

  test("a native write failure terminates bookkeeping and surfaces the error", async () => {
    const onEnded = mock(() => {})
    await audioPlaybackService.openStream({
      appId: "com.example.call",
      channels: 1,
      onEnded,
      sampleRate: 16_000,
      streamId: "broken",
    })
    pcmStreamWrite.mockImplementationOnce(async () => {
      throw new Error("native output failed")
    })

    await expect(audioPlaybackService.writeStreamChunk("broken", "AAAA")).rejects.toThrow("native output failed")
    expect(onEnded).toHaveBeenCalledWith("broken", false, "native output failed", expect.any(Number))
    expect(audioPlaybackService.getActiveCount()).toBe(0)
  })

  test("stopForApp leaves another miniapp's stream running", async () => {
    await audioPlaybackService.openStream({
      appId: "app-one",
      channels: 1,
      onEnded: () => {},
      sampleRate: 16_000,
      stopOtherAudio: false,
      streamId: "one",
    })
    await audioPlaybackService.openStream({
      appId: "app-two",
      channels: 1,
      onEnded: () => {},
      sampleRate: 16_000,
      stopOtherAudio: false,
      streamId: "two",
    })

    await audioPlaybackService.stopForApp("app-one")

    expect(pcmStreamAbort).toHaveBeenCalledWith("one")
    expect(pcmStreamAbort).not.toHaveBeenCalledWith("two")
    expect(audioPlaybackService.getActiveAppIds()).toEqual(["app-two"])
  })

  test("replacing URL playback reports an explicit interruption", async () => {
    const firstComplete = mock(() => {})

    await audioPlaybackService.play(
      {requestId: "first-url", audioUrl: "file://first.wav", appId: "app-one", stopOtherAudio: false},
      firstComplete,
    )
    await audioPlaybackService.play(
      {requestId: "second-url", audioUrl: "file://second.wav", appId: "app-two", stopOtherAudio: false},
      () => {},
    )

    expect(firstComplete).toHaveBeenCalledTimes(1)
    expect(firstComplete).toHaveBeenCalledWith("first-url", true, null, expect.any(Number), "interrupted")
  })

  test("only suppresses cloud STT when the caller opts in", async () => {
    await audioPlaybackService.play(
      {requestId: "sound-effect", audioUrl: "file://click.wav", appId: "app-one"},
      () => {},
    )
    expect(setAudioCloudUplinkSuppressed).not.toHaveBeenCalled()

    audioPlaybackService.cancelPlayback("sound-effect")
    setAudioCloudUplinkSuppressed.mockClear()

    await audioPlaybackService.play(
      {
        requestId: "spoken-tts",
        audioUrl: "file://speech.wav",
        appId: "app-one",
        suppressCloudUplink: true,
      },
      () => {},
    )
    expect(setAudioCloudUplinkSuppressed).toHaveBeenCalledWith("url:spoken-tts", true)

    audioPlaybackService.cancelPlayback("spoken-tts")
    expect(setAudioCloudUplinkSuppressed).toHaveBeenCalledWith("url:spoken-tts", false)
  })

  test("cancels active URL playback immediately by request id", async () => {
    const onComplete = mock(() => {})
    await audioPlaybackService.play(
      {requestId: "active-tts", audioUrl: "file://speech.wav", appId: "app-one"},
      onComplete,
    )

    audioPlaybackService.cancelPlayback("active-tts")

    expect(audioPlayer.pause).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith("active-tts", true, null, expect.any(Number), "interrupted")
    expect(audioPlaybackService.isPlaying()).toBe(false)
  })

  test("prevents a cancelled pending URL request from starting", async () => {
    let finishAudioSetup: (() => void) | undefined
    setAudioModeAsync.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAudioSetup = resolve
        }),
    )
    const onComplete = mock(() => {})
    const playPromise = audioPlaybackService.play(
      {requestId: "pending-tts", audioUrl: "file://speech.wav", appId: "app-one"},
      onComplete,
    )

    audioPlaybackService.cancelPlayback("pending-tts")
    finishAudioSetup?.()
    await playPromise

    expect(audioPlayer.replace).not.toHaveBeenCalled()
    expect(audioPlayer.play).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith("pending-tts", true, null, 0, "interrupted")
    expect(audioPlaybackService.isPlaying()).toBe(false)
  })
})
