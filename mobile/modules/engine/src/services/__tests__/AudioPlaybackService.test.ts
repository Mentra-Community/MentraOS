/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"

import {
  emitLc3Frame,
  pcmStreamAbort,
  pcmStreamClose,
  pcmStreamOpen,
  pcmStreamWrite,
  resetAudioTestMocks,
  sendAudioFrame,
  setOwnAppAudioPlaying,
} from "./audioTestMocks"

const setAudioModeAsync = mock(async () => {})
const tailTimerCallbacks: Array<() => void> = []

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
    setTimeout: (callback: () => void, delayMs: number) => {
      if (delayMs === 700) {
        tailTimerCallbacks.push(callback)
        return 1
      }
      callback()
      return 1
    },
  },
}))

const {startAudioCloudUplink, stopAudioCloudUplink} = require("../AudioCloudUplink")
const audioPlaybackService = require("../AudioPlaybackService").default

describe("AudioPlaybackService live PCM streams", () => {
  beforeEach(async () => {
    await audioPlaybackService.stopAll()
    stopAudioCloudUplink()
    resetAudioTestMocks()
    tailTimerCallbacks.length = 0
    startAudioCloudUplink()
    setAudioModeAsync.mockClear()
    setAudioModeAsync.mockImplementation(async () => {})
    audioPlayer.pause.mockClear()
    audioPlayer.play.mockClear()
    audioPlayer.replace.mockClear()
  })

  afterEach(async () => {
    await audioPlaybackService.stopAll()
    stopAudioCloudUplink()
  })

  test("prewarms a cold Android route by aborting silence before URL playback", async () => {
    await audioPlaybackService.play({audioUrl: "https://example.test/click.wav", requestId: "click"}, () => {})

    expect(pcmStreamOpen).toHaveBeenCalledTimes(1)
    expect(pcmStreamWrite).toHaveBeenCalledTimes(1)
    expect(pcmStreamAbort).toHaveBeenCalledTimes(1)
    expect(pcmStreamClose).not.toHaveBeenCalled()
    expect(audioPlayer.play).toHaveBeenCalledTimes(1)
  })

  test("prewarms a cold Android route before opening a live PCM stream", async () => {
    const coldNow = Date.now() + 10_000
    const dateNow = spyOn(Date, "now").mockReturnValue(coldNow)
    try {
      await audioPlaybackService.openStream({
        appId: "com.example.call",
        channels: 1,
        onEnded: () => {},
        sampleRate: 24_000,
        streamId: "stream-cold",
        volume: 0.75,
      })
    } finally {
      dateNow.mockRestore()
    }

    expect(pcmStreamOpen).toHaveBeenCalledTimes(2)
    expect(pcmStreamOpen).toHaveBeenNthCalledWith(1, expect.stringContaining("audio-route-prewarm-"), 16_000, 1, 1)
    expect(pcmStreamWrite).toHaveBeenCalledTimes(1)
    expect(pcmStreamAbort).toHaveBeenCalledTimes(1)
    expect(pcmStreamOpen).toHaveBeenNthCalledWith(2, "stream-cold", 24_000, 1, 0.75)
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
    emitLc3Frame([1])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)
    expect(audioPlaybackService.isPlaying()).toBe(true)
    expect(audioPlaybackService.getActiveAppIds()).toEqual(["com.example.call"])
    expect(audioPlaybackService.getActiveCount()).toBe(1)

    await expect(audioPlaybackService.writeStreamChunk("stream-1", "AAAA")).resolves.toEqual({bufferedMs: 120})
    await expect(audioPlaybackService.closeStream("stream-1")).resolves.toEqual({durationMs: 1_500})

    expect(pcmStreamWrite).toHaveBeenCalledWith("stream-1", "AAAA")
    expect(pcmStreamClose).toHaveBeenCalledWith("stream-1")
    expect(onEnded).toHaveBeenCalledWith("stream-1", true, null, 1_500)
    emitLc3Frame([2])
    expect(sendAudioFrame).toHaveBeenCalledTimes(2)
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

  test("keeps native audio marked active when URL playback finishes beside a live PCM stream", async () => {
    await audioPlaybackService.openStream({
      appId: "stream-app",
      channels: 1,
      onEnded: () => {},
      sampleRate: 16_000,
      stopOtherAudio: false,
      streamId: "ongoing-stream",
    })
    await audioPlaybackService.play(
      {requestId: "short-url", audioUrl: "file://short.wav", appId: "url-app", stopOtherAudio: false},
      () => {},
    )
    setOwnAppAudioPlaying.mockClear()

    const playbackStatusTarget = audioPlaybackService as unknown as {
      onPlaybackStatusUpdate(status: {didJustFinish: boolean; duration: number}): void
    }
    playbackStatusTarget.onPlaybackStatusUpdate({didJustFinish: true, duration: 1})

    expect(audioPlaybackService.getActiveAppIds()).toEqual(["stream-app"])
    expect(setOwnAppAudioPlaying).not.toHaveBeenCalledWith(false)

    await audioPlaybackService.closeStream("ongoing-stream")
    expect(setOwnAppAudioPlaying).toHaveBeenCalledWith(false)
  })

  test("only suppresses cloud STT when the caller opts in", async () => {
    await audioPlaybackService.play(
      {requestId: "sound-effect", audioUrl: "file://click.wav", appId: "app-one"},
      () => {},
    )
    emitLc3Frame([1])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    audioPlaybackService.cancelPlayback("sound-effect")

    await audioPlaybackService.play(
      {
        requestId: "spoken-tts",
        audioUrl: "file://speech.wav",
        appId: "app-one",
        suppressCloudUplink: true,
      },
      () => {},
    )
    emitLc3Frame([2])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    audioPlaybackService.cancelPlayback("spoken-tts")
    emitLc3Frame([3])
    expect(sendAudioFrame).toHaveBeenCalledTimes(2)
  })

  test("releases a completed TTS tail gate when a live PCM cue starts", async () => {
    const onComplete = mock(() => {})
    await audioPlaybackService.play(
      {
        requestId: "spoken-tts",
        audioUrl: "file://speech.wav",
        appId: "app-one",
        suppressCloudUplink: true,
      },
      onComplete,
    )

    const playbackStatusTarget = audioPlaybackService as unknown as {
      onPlaybackStatusUpdate(status: {didJustFinish: boolean; duration: number}): void
    }
    playbackStatusTarget.onPlaybackStatusUpdate({didJustFinish: true, duration: 1})
    expect(onComplete).toHaveBeenCalledWith("spoken-tts", true, null, 1_000, "completed")

    emitLc3Frame([1])
    expect(sendAudioFrame).toHaveBeenCalledTimes(0)

    await audioPlaybackService.openStream({
      appId: "app-one",
      channels: 1,
      onEnded: () => {},
      sampleRate: 16_000,
      streamId: "cue-stream",
    })
    emitLc3Frame([2])
    expect(sendAudioFrame).toHaveBeenCalledTimes(1)

    for (const callback of tailTimerCallbacks.splice(0)) callback()
  })

  test("unloads a completed URL after its A2DP tail so media play cannot replay it", async () => {
    await audioPlaybackService.play(
      {requestId: "finished-tts", audioUrl: "file://speech.wav", appId: "app-one"},
      () => {},
    )

    const playbackStatusTarget = audioPlaybackService as unknown as {
      onPlaybackStatusUpdate(status: {didJustFinish: boolean; duration: number}): void
    }
    playbackStatusTarget.onPlaybackStatusUpdate({didJustFinish: true, duration: 1})

    expect(audioPlayer.replace).toHaveBeenLastCalledWith({uri: "file://speech.wav"})
    for (const callback of tailTimerCallbacks.splice(0)) callback()
    expect(audioPlayer.replace).toHaveBeenLastCalledWith(null)
  })

  test("does not let an older tail timer unload a newer completed URL", async () => {
    const playbackStatusTarget = audioPlaybackService as unknown as {
      onPlaybackStatusUpdate(status: {didJustFinish: boolean; duration: number}): void
    }

    await audioPlaybackService.play({requestId: "first-tts", audioUrl: "file://first.wav"}, () => {})
    playbackStatusTarget.onPlaybackStatusUpdate({didJustFinish: true, duration: 1})

    await audioPlaybackService.play({requestId: "second-tts", audioUrl: "file://second.wav"}, () => {})
    playbackStatusTarget.onPlaybackStatusUpdate({didJustFinish: true, duration: 1})

    const firstTail = tailTimerCallbacks.shift()
    firstTail?.()
    expect(audioPlayer.replace).toHaveBeenLastCalledWith({uri: "file://second.wav"})

    const secondTail = tailTimerCallbacks.shift()
    secondTail?.()
    expect(audioPlayer.replace).toHaveBeenLastCalledWith(null)
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
