import BluetoothSdk from "@mentra/bluetooth-sdk"
import {AudioStatus, createAudioPlayer, setAudioModeAsync} from "expo-audio"

import audioPlaybackService from "@/../modules/engine/src/services/AudioPlaybackService"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@/../modules/engine/src/services/audioPlaybackAssets", () => ({
  SILENT_AUDIO_SOURCE: 9001,
}))

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

const mockPlayer = {
  addListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  remove: jest.fn(),
  replace: jest.fn(),
  volume: 1,
  currentStatus: {currentTime: 0, isLoaded: false, playbackState: "unknown"},
}

type MockPlaybackStatus = Partial<AudioStatus>

function getLatestStatusListener() {
  const calls = mockPlayer.addListener.mock.calls
  const statusListener = calls[calls.length - 1]?.[1]
  expect(statusListener).toBeDefined()
  return statusListener as (status: MockPlaybackStatus) => void
}

async function flushAsyncVolumeGuard() {
  await Promise.resolve()
  await Promise.resolve()
}

jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => mockPlayer),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}))

describe("AudioPlaybackService", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    resetBluetoothSdkMock()
    mockPlayer.volume = 1
    mockPlayer.currentStatus = {currentTime: 0, isLoaded: false, playbackState: "unknown"}
    ;(BluetoothSdk.getGlassesMediaVolume as jest.Mock).mockResolvedValue({level: 1, statusCode: 0})
  })

  afterEach(() => {
    audioPlaybackService.release()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("bumps low Mentra Live volume, suspends mic while playing, and leaves the volume bumped", async () => {
    const onComplete = jest.fn()

    await audioPlaybackService.play(
      {
        requestId: "audio-1",
        audioUrl: "https://example.com/audio.mp3",
        volume: 0.25,
      },
      onComplete,
    )
    await flushAsyncVolumeGuard()

    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldPlayInBackground: true,
      }),
    )
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenCalledWith(9)
    expect(mockPlayer.volume).toBe(0.25)
    expect(mockPlayer.replace).toHaveBeenCalledWith({uri: "https://example.com/audio.mp3"})
    expect(mockPlayer.play).toHaveBeenCalled()
    expect(BluetoothSdk.setOwnAppAudioPlaying).toHaveBeenCalledWith(true)

    const statusListener = getLatestStatusListener()
    statusListener({didJustFinish: true, duration: 2})

    expect(mockPlayer.pause).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith("audio-1", true, null, 2000, "completed")
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenCalledTimes(1)
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenLastCalledWith(9)

    jest.advanceTimersByTime(900)
    expect(mockPlayer.pause).toHaveBeenCalled()
    expect(mockPlayer.replace).toHaveBeenLastCalledWith(9001)
    expect(mockPlayer.remove).not.toHaveBeenCalled()

    jest.advanceTimersByTime(600)
    await Promise.resolve()
    expect(BluetoothSdk.setOwnAppAudioPlaying).toHaveBeenLastCalledWith(false)
  })

  it("interrupts existing playback without restoring bumped volume after the replacement finishes", async () => {
    const firstComplete = jest.fn()
    const secondComplete = jest.fn()

    await audioPlaybackService.play({requestId: "first", audioUrl: "https://example.com/one.mp3"}, firstComplete)
    await flushAsyncVolumeGuard()
    await audioPlaybackService.play({requestId: "second", audioUrl: "https://example.com/two.mp3"}, secondComplete)
    await flushAsyncVolumeGuard()

    expect(firstComplete).toHaveBeenCalledWith("first", true, null, expect.any(Number), "interrupted")
    expect(mockPlayer.replace.mock.calls.slice(0, 3)).toEqual([
      [{uri: "https://example.com/one.mp3"}],
      [9001],
      [{uri: "https://example.com/two.mp3"}],
    ])
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenCalledTimes(1)
    expect(createAudioPlayer).toHaveBeenCalledTimes(1)

    const statusListener = getLatestStatusListener()
    statusListener({didJustFinish: true, duration: 1})

    expect(secondComplete).toHaveBeenCalledWith("second", true, null, 1000, "completed")
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenCalledTimes(1)
    expect(BluetoothSdk.setGlassesMediaVolume).toHaveBeenLastCalledWith(9)
  })

  it("does not let an older tail timer unload a newer completed source", async () => {
    await audioPlaybackService.play({requestId: "first", audioUrl: "https://example.com/one.mp3"}, jest.fn())
    const statusListener = getLatestStatusListener()
    statusListener({didJustFinish: true, duration: 1})

    jest.advanceTimersByTime(300)
    await audioPlaybackService.play({requestId: "second", audioUrl: "https://example.com/two.mp3"}, jest.fn())
    statusListener({didJustFinish: true, duration: 1})

    jest.advanceTimersByTime(400)
    expect(mockPlayer.replace).toHaveBeenLastCalledWith({uri: "https://example.com/two.mp3"})

    jest.advanceTimersByTime(300)
    expect(mockPlayer.replace).toHaveBeenLastCalledWith(9001)
    expect(mockPlayer.remove).not.toHaveBeenCalled()
  })

  it("unloads cancelled playback so Bluetooth media play cannot resume it", async () => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "cancelled", audioUrl: "https://example.com/speech.mp3", appId: "com.mentra.merge"},
      onComplete,
    )

    audioPlaybackService.cancelPlayback("cancelled")

    expect(mockPlayer.pause).toHaveBeenCalled()
    expect(mockPlayer.replace).toHaveBeenLastCalledWith(9001)
    expect(mockPlayer.remove).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith("cancelled", true, null, expect.any(Number), "interrupted")
  })

  it("starts playback without waiting for a slow glasses volume response", async () => {
    const onComplete = jest.fn()
    ;(BluetoothSdk.getGlassesMediaVolume as jest.Mock).mockReturnValue(new Promise(() => {}))

    await audioPlaybackService.play(
      {
        requestId: "slow-volume",
        audioUrl: "https://example.com/slow.mp3",
      },
      onComplete,
    )

    expect(mockPlayer.replace).toHaveBeenCalledWith({uri: "https://example.com/slow.mp3"})
    expect(mockPlayer.play).toHaveBeenCalled()
    expect(BluetoothSdk.setGlassesMediaVolume).not.toHaveBeenCalled()
  })

  it("fails cloud speech that never starts even when iOS emits no status events", async () => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "stalled", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )

    jest.advanceTimersByTime(9_999)
    expect(onComplete).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)

    expect(onComplete).toHaveBeenCalledWith("stalled", false, "Audio did not start within 10000ms", null, "error")
    expect(mockPlayer.replace).toHaveBeenLastCalledWith(9001)
    expect(audioPlaybackService.isPlaying()).toBe(false)
    getLatestStatusListener()({didJustFinish: true, duration: 0})
    expect(onComplete).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1_500)
    expect(BluetoothSdk.setOwnAppAudioPlaying).toHaveBeenLastCalledWith(false)
  })

  it("allows speech that has started to finish beyond its startup deadline", async () => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "long-speech", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )
    // Read native progress at the deadline even if JS status events were delayed.
    mockPlayer.currentStatus = {currentTime: 9, isLoaded: true, playbackState: "readyToPlay"}
    jest.advanceTimersByTime(20_000)
    expect(onComplete).not.toHaveBeenCalled()
    getLatestStatusListener()({didJustFinish: true, duration: 25})
    expect(onComplete).toHaveBeenCalledWith("long-speech", true, null, 25_000, "completed")
  })

  it("does not treat a loaded but motionless player as started", async () => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "loaded-stall", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )
    mockPlayer.currentStatus = {currentTime: 0, isLoaded: true, playbackState: "readyToPlay"}
    jest.advanceTimersByTime(10_000)
    expect(onComplete).toHaveBeenCalledWith("loaded-stall", false, expect.any(String), null, "error")
  })

  it("cancels the startup deadline when another request interrupts speech", async () => {
    const firstComplete = jest.fn()
    const secondComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "old", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      firstComplete,
    )
    jest.advanceTimersByTime(5_000)
    await audioPlaybackService.play({requestId: "new", audioUrl: "file://cue.wav"}, secondComplete)
    jest.advanceTimersByTime(10_000)
    expect(firstComplete).toHaveBeenCalledTimes(1)
    expect(firstComplete).toHaveBeenCalledWith("old", true, null, 5_000, "interrupted")
    expect(secondComplete).not.toHaveBeenCalled()
    expect(mockPlayer.replace).toHaveBeenLastCalledWith({uri: "file://cue.wav"})
  })

  it("allows a timeout callback to start fallback playback without a later stop", async () => {
    const fallbackComplete = jest.fn()
    let fallbackStart: Promise<void> | undefined
    const onComplete = jest.fn(() => {
      fallbackStart = audioPlaybackService.play({requestId: "offline", audioUrl: "file://speech.wav"}, fallbackComplete)
    })
    await audioPlaybackService.play(
      {requestId: "cloud", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )
    jest.advanceTimersByTime(10_000)
    await fallbackStart
    jest.advanceTimersByTime(2_000)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(mockPlayer.replace).toHaveBeenLastCalledWith({uri: "file://speech.wav"})
    expect(BluetoothSdk.setOwnAppAudioPlaying).toHaveBeenLastCalledWith(true)
    expect(fallbackComplete).not.toHaveBeenCalled()
  })

  it.each(["cancel", "release", "complete"])("clears the startup deadline on %s", async (action) => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "finished", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )
    if (action === "cancel") audioPlaybackService.cancelPlayback("finished")
    else if (action === "release") audioPlaybackService.release()
    else getLatestStatusListener()({didJustFinish: true, duration: 2})

    jest.advanceTimersByTime(2_000)
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(10_000)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete.mock.calls[0][1]).toBe(true)
  })

  it.each(["idle", "failed"])("reports native %s failure once and cancels the startup deadline", async (state) => {
    const onComplete = jest.fn()
    await audioPlaybackService.play(
      {requestId: "failed", audioUrl: "https://example.com/tts", startTimeoutMs: 10_000},
      onComplete,
    )
    jest.advanceTimersByTime(2_000)
    const status = {playbackState: state, isLoaded: false, isBuffering: false}
    getLatestStatusListener()(status)
    getLatestStatusListener()(status)
    jest.advanceTimersByTime(10_000)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith("failed", false, expect.any(String), null, "error")
    expect(mockPlayer.replace).toHaveBeenLastCalledWith(9001)
  })
})
