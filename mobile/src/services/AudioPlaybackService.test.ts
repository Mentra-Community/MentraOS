import CoreModule from "@mentra/bluetooth-sdk"
import {createAudioPlayer, setAudioModeAsync} from "expo-audio"

import audioPlaybackService from "@/services/AudioPlaybackService"
import {resetCoreModuleMock} from "@/test-utils/mockCoreModule"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

const mockPlayer = {
  addListener: jest.fn(),
  pause: jest.fn(),
  play: jest.fn(),
  remove: jest.fn(),
  replace: jest.fn(),
  volume: 1,
}

type MockPlaybackStatus = {
  didJustFinish: boolean
  duration: number
}

function getLatestStatusListener() {
  const calls = mockPlayer.addListener.mock.calls
  const statusListener = calls[calls.length - 1]?.[1]
  expect(statusListener).toBeDefined()
  return statusListener as (status: MockPlaybackStatus) => void
}

jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => mockPlayer),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}))

describe("AudioPlaybackService", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    resetCoreModuleMock()
    mockPlayer.volume = 1
    ;(CoreModule.getGlassesMediaVolume as jest.Mock).mockResolvedValue({vol: 1, statusCode: 0})
  })

  afterEach(() => {
    audioPlaybackService.release()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("bumps low Mentra Live volume, suspends mic while playing, then restores on finish", async () => {
    const onComplete = jest.fn()

    await audioPlaybackService.play(
      {
        requestId: "audio-1",
        audioUrl: "https://example.com/audio.mp3",
        volume: 0.25,
      },
      onComplete,
    )

    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldPlayInBackground: true,
      }),
    )
    expect(CoreModule.setGlassesMediaVolume).toHaveBeenCalledWith(9)
    expect(mockPlayer.volume).toBe(0.25)
    expect(mockPlayer.replace).toHaveBeenCalledWith({uri: "https://example.com/audio.mp3"})
    expect(mockPlayer.play).toHaveBeenCalled()
    expect(CoreModule.setOwnAppAudioPlaying).toHaveBeenCalledWith(true)

    const statusListener = getLatestStatusListener()
    statusListener({didJustFinish: true, duration: 2})

    expect(onComplete).toHaveBeenCalledWith("audio-1", true, null, 2000)
    expect(CoreModule.setGlassesMediaVolume).toHaveBeenLastCalledWith(1)

    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(CoreModule.setOwnAppAudioPlaying).toHaveBeenLastCalledWith(false)
  })

  it("interrupts existing playback without restoring bumped volume until the replacement finishes", async () => {
    const firstComplete = jest.fn()
    const secondComplete = jest.fn()

    await audioPlaybackService.play({requestId: "first", audioUrl: "https://example.com/one.mp3"}, firstComplete)
    await audioPlaybackService.play({requestId: "second", audioUrl: "https://example.com/two.mp3"}, secondComplete)

    expect(firstComplete).toHaveBeenCalledWith("first", true, null, expect.any(Number))
    expect(CoreModule.setGlassesMediaVolume).toHaveBeenCalledTimes(1)
    expect(createAudioPlayer).toHaveBeenCalledTimes(1)

    const statusListener = getLatestStatusListener()
    statusListener({didJustFinish: true, duration: 1})

    expect(secondComplete).toHaveBeenCalledWith("second", true, null, 1000)
    expect(CoreModule.setGlassesMediaVolume).toHaveBeenLastCalledWith(1)
  })
})
