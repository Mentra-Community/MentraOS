/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

const settingsSubscribe = mock(() => () => {})
const coreSubscribe = mock(() => () => {})
let preferredMic = "glasses"
let currentMic: string | null = "glasses"
let micRanking: string[] = ["glasses"]
let glassesConnected = true

mock.module("../../stores/settings", () => ({
  SETTINGS: {preferred_mic: {key: "preferred_mic"}},
  useSettingsStore: {
    getState: () => ({
      getSetting: () => preferredMic,
    }),
    subscribe: settingsSubscribe,
  },
}))

mock.module("../../stores/core", () => ({
  useCoreStore: {
    getState: () => ({currentMic, micRanking}),
    subscribe: coreSubscribe,
  },
}))

mock.module("../../stores/glasses", () => ({
  isGlassesConnected: () => glassesConnected,
  useGlassesStore: {
    getState: () => ({connection: {}}),
  },
}))

const openStream = mock(async (_request: {streamId: string; sampleRate: number; channels: number}) => {})
const abortStream = mock(async () => {})
const writeStreamChunk = mock(async (_streamId: string, _base64: string) => ({bufferedMs: 0}))
mock.module("../AudioPlaybackService", () => ({
  default: {openStream, abortStream, writeStreamChunk},
}))

mock.module("expo-audio", () => ({
  createAudioPlayer: () => ({}),
  setAudioModeAsync: async () => {},
}))
mock.module("react-native", () => ({
  AppState: {addEventListener: () => ({remove: () => {}})},
  Platform: {OS: "android"},
}))
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {},
}))

const {
  default: acsMeetingService,
  parseAcsOutgoingVideo,
  parseMeetingParticipants,
  ACS_CALL_MIC,
  resolveAcsAudioSource,
  setAcsMeetingNativeForTests,
  setAcsMeetingPhoneNetworkForTests,
} = require("../AcsMeetingService") as typeof import("../AcsMeetingService")

type PhoneNetworkInfo = import("../AcsMeetingService").PhoneNetworkInfo

function fakePhoneNetwork() {
  const listeners = new Set<(state: PhoneNetworkInfo) => void>()
  return {
    addEventListener: (listener: (state: PhoneNetworkInfo) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (state: PhoneNetworkInfo) => listeners.forEach((listener) => listener(state)),
    get size() {
      return listeners.size
    },
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type NativeJoin = {
  meetingUrl: string
  token: string
  whepUrl: string
  displayName?: string
  audioSource?: "glasses" | "phone"
  video?: {width: number; height: number; fps: number; maxBitrateBps: number}
}

function fakeNative() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const join = mock(async (options: NativeJoin) => ({
    state: "connected" as const,
    muted: false,
    provider: "acs-teams" as const,
    audioSource: options.audioSource,
    activeStream: options.audioSource === "phone" ? ("local" as const) : ("virtual" as const),
    audioSafety: "safe" as const,
  }))
  const leave = mock(async () => {})
  const setMuted = mock(async (muted: boolean) => ({state: "connected" as const, muted}))
  const setAudioSource = mock(async (source: "glasses" | "phone") => ({
    state: "connected" as const,
    muted: false,
    audioSource: source,
  }))
  const updateVideoSource = mock(async () => {})
  const restartVideoSource = mock(async () => {})
  const getState = mock(async () => ({state: "idle" as const, muted: false}))
  return {
    join,
    leave,
    setMuted,
    setAudioSource,
    updateVideoSource,
    restartVideoSource,
    getState,
    addListener: (event: string, listener: (event: Record<string, unknown>) => void) => {
      listeners.set(event, listener)
      return {remove: () => listeners.delete(event)}
    },
    emit: (event: string, payload: Record<string, unknown>) => listeners.get(event)?.(payload),
  }
}

describe("AcsMeetingService", () => {
  beforeEach(() => {
    preferredMic = "glasses"
    currentMic = "glasses"
    micRanking = ["glasses"]
    glassesConnected = true
    settingsSubscribe.mockClear()
    coreSubscribe.mockClear()
    openStream.mockClear()
    abortStream.mockClear()
    writeStreamChunk.mockClear()
  })

  afterEach(async () => {
    await acsMeetingService.leave("com.mentra.call")
    setAcsMeetingNativeForTests(undefined)
    setAcsMeetingPhoneNetworkForTests(null)
  })

  test("a failed native join releases ownership, unbinds listeners, and hangs up native", async () => {
    const native = fakeNative()
    native.join.mockImplementationOnce(async () => {
      throw new Error("ACS rejected the token")
    })
    setAcsMeetingNativeForTests(native)
    const original = console.warn
    console.warn = () => {}
    try {
      await expect(
        acsMeetingService.join("com.mentra.call", {
          meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
          token: "bad",
          whepUrl: "https://example.com/whep",
        }),
      ).rejects.toThrow("ACS rejected the token")
    } finally {
      console.warn = original
    }
    expect(acsMeetingService.ownerPackage()).toBeNull()
    expect(native.leave).toHaveBeenCalledTimes(1)
    expect(openStream).not.toHaveBeenCalled()
    // Another miniapp is not locked out by the failed attempt.
    await acsMeetingService.join("com.other.app", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/y",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(acsMeetingService.ownerPackage()).toBe("com.other.app")
    await acsMeetingService.leave("com.other.app")
  })

  test("return-audio playback failure does not reject a join that native accepted", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    openStream.mockImplementationOnce(async () => {
      throw new Error("A2DP busy")
    })
    const original = console.warn
    console.warn = () => {}
    let state: Awaited<ReturnType<typeof acsMeetingService.join>>
    try {
      state = await acsMeetingService.join("com.mentra.call", {
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
        token: "tok",
        whepUrl: "https://example.com/whep",
      })
    } finally {
      console.warn = original
    }
    expect(state.state).toBe("connected")
    expect(acsMeetingService.ownerPackage()).toBe("com.mentra.call")
    expect(native.leave).not.toHaveBeenCalled()
    // The next incoming PCM chunk lazily reopens playback.
    native.emit("onIncomingPcm", {base64: "AAAA", sampleRate: 16000, channels: 1})
    await flush()
    await flush()
    expect(openStream).toHaveBeenCalledTimes(2)
    expect(writeStreamChunk).toHaveBeenCalledTimes(1)
  })

  test("leave unbinds native listeners so stale events do not reach the old owner", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    const seen: string[] = []
    acsMeetingService.setStateHandler((_pkg, state) => {
      seen.push(state.state)
    })
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    native.emit("onState", {state: "connected", muted: false})
    await acsMeetingService.leave("com.mentra.call")
    native.emit("onState", {state: "disconnected", muted: false})
    expect(seen).toEqual(["connected"])
    acsMeetingService.setStateHandler(() => {})
  })

  test("mute and video-source updates require an active owner", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await expect(acsMeetingService.setMuted("com.mentra.call", true)).rejects.toThrow(/No active meeting/)
    await expect(acsMeetingService.updateVideoSource("com.mentra.call", "https://x/whep")).rejects.toThrow(
      /No active meeting/,
    )
    expect(native.setMuted).not.toHaveBeenCalled()
    expect(native.updateVideoSource).not.toHaveBeenCalled()
  })

  test("a phone network change during a live meeting rebuilds the WHEP subscription once", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    const network = fakePhoneNetwork()
    setAcsMeetingPhoneNetworkForTests(network)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(network.size).toBe(1)
    // NetInfo replays the current state on subscribe; that is not a change.
    network.emit({type: "wifi", isConnected: true})
    expect(native.restartVideoSource).not.toHaveBeenCalled()
    // Going offline is not worth a restart; coming back on a new network is.
    network.emit({type: "none", isConnected: false})
    expect(native.restartVideoSource).not.toHaveBeenCalled()
    network.emit({type: "cellular", isConnected: true})
    await flush()
    expect(native.restartVideoSource).toHaveBeenCalledTimes(1)
    expect(native.updateVideoSource).not.toHaveBeenCalled()
    // Flapping within the cooldown is absorbed.
    network.emit({type: "wifi", isConnected: true})
    await flush()
    expect(native.restartVideoSource).toHaveBeenCalledTimes(1)
    await acsMeetingService.leave("com.mentra.call")
    expect(network.size).toBe(0)
  })

  test("a native without restartVideoSource falls back to a same-URL updateVideoSource", async () => {
    const {restartVideoSource: _omitted, ...native} = fakeNative()
    setAcsMeetingNativeForTests(native)
    const network = fakePhoneNetwork()
    setAcsMeetingPhoneNetworkForTests(network)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    network.emit({type: "wifi", isConnected: true})
    network.emit({type: "cellular", isConnected: true})
    await flush()
    expect(native.updateVideoSource).toHaveBeenCalledWith("https://example.com/whep")
  })

  test("native mediaSource health is carried on the meeting state", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    native.emit("onState", {state: "connected", muted: false, mediaSource: "failed"})
    expect(acsMeetingService.getState().mediaSource).toBe("failed")
    native.emit("onState", {state: "connected", muted: false, mediaSource: "bogus"})
    expect(acsMeetingService.getState().mediaSource).toBeUndefined()
  })

  test("the call microphone follows ACS_CALL_MIC and ignores preferred_mic", () => {
    for (const mic of ["glasses", "phone", "bluetooth", "auto", ""]) {
      preferredMic = mic
      expect(resolveAcsAudioSource()).toEqual({source: ACS_CALL_MIC, reason: "explicit"})
    }
  })

  test("join passes ACS_CALL_MIC, opens 16 kHz mono playback, and does not watch stores", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    preferredMic = "glasses"
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(native.join).toHaveBeenCalledWith(
      expect.objectContaining({audioSource: ACS_CALL_MIC}),
    )
    expect(state.audioSource).toBe(ACS_CALL_MIC)
    expect(state.audioSourceReason).toBe("explicit")
    expect(openStream).toHaveBeenCalledTimes(1)
    expect(openStream.mock.calls[0]?.[0]).toMatchObject({sampleRate: 16000, channels: 1, stopOtherAudio: true})
    expect(settingsSubscribe).not.toHaveBeenCalled()
    expect(coreSubscribe).not.toHaveBeenCalled()
    expect(native.setAudioSource).not.toHaveBeenCalled()
  })

  test("incoming PCM is written in order to the open stream", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    native.emit("onIncomingPcm", {base64: "AAAA", sampleRate: 16000, channels: 1})
    native.emit("onIncomingPcm", {base64: "BBBB", sampleRate: 16000, channels: 1})
    await flush()
    await flush()
    expect(writeStreamChunk.mock.calls.map((call) => call[1])).toEqual(["AAAA", "BBBB"])
    expect(openStream).toHaveBeenCalledTimes(1)
  })

  test("a different incoming PCM format reopens the player instead of playing at the wrong rate", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    native.emit("onIncomingPcm", {base64: "AAAA", sampleRate: 48000, channels: 1})
    await flush()
    await flush()
    expect(abortStream).toHaveBeenCalledTimes(1)
    expect(openStream).toHaveBeenCalledTimes(2)
    expect(openStream.mock.calls[1]?.[0]).toMatchObject({sampleRate: 48000, channels: 1})
    expect(writeStreamChunk).toHaveBeenCalledTimes(1)
  })

  test("unsupported incoming PCM formats are dropped, never played", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    const original = console.warn
    console.warn = () => {}
    try {
      native.emit("onIncomingPcm", {base64: "AAAA", sampleRate: 44100, channels: 2})
      await flush()
      await flush()
    } finally {
      console.warn = original
    }
    expect(writeStreamChunk).not.toHaveBeenCalled()
    expect(openStream).toHaveBeenCalledTimes(1)
  })

  test("native participants are parsed into the meeting state", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    native.emit("onState", {
      state: "connected",
      muted: false,
      audioSource: "glasses",
      activeStream: "virtual",
      audioSafety: "safe",
      participants: [
        {id: "8:orgid:abc", displayName: "Israelov", state: "connected", isMuted: false, isSpeaking: true},
        {id: "8:orgid:def", displayName: "", state: "weird", isMuted: true},
        {id: "", displayName: "dropped"},
        "garbage",
      ],
    })
    expect(acsMeetingService.getState().participants).toEqual([
      {id: "8:orgid:abc", displayName: "Israelov", state: "connected", isMuted: false, isSpeaking: true},
      {id: "8:orgid:def", displayName: null, state: "idle", isMuted: true, isSpeaking: false},
    ])
    expect(parseMeetingParticipants(undefined)).toBeUndefined()
    expect(parseMeetingParticipants([])).toEqual([])
  })

  test("join forwards optional outgoing video to native", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    const video = {width: 960, height: 540, fps: 30, maxBitrateBps: 1_500_000}
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
      video,
    })
    expect(native.join).toHaveBeenCalledWith(expect.objectContaining({video}))
  })

  test("parseAcsOutgoingVideo accepts documented 16:9 sizes and rejects 540×960 and 854×480", () => {
    expect(parseAcsOutgoingVideo({width: 1280, height: 720, fps: 15, maxBitrateBps: 2_500_000})).toEqual({
      width: 1280,
      height: 720,
      fps: 15,
      maxBitrateBps: 2_500_000,
    })
    expect(parseAcsOutgoingVideo({width: 960, height: 540, fps: 30, maxBitrateBps: 1_500_000})).toEqual({
      width: 960,
      height: 540,
      fps: 30,
      maxBitrateBps: 1_500_000,
    })
    expect(() => parseAcsOutgoingVideo({width: 540, height: 960, fps: 30, maxBitrateBps: 1_500_000})).toThrow(
      /unsupported ACS video 540x960/,
    )
    expect(() => parseAcsOutgoingVideo({width: 854, height: 480, fps: 15, maxBitrateBps: 1_500_000})).toThrow(
      /unsupported ACS video 854x480/,
    )
  })

  test("a second join on a reused session re-resolves the audioSource and reopens playback", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    await acsMeetingService.leave("com.mentra.call")
    expect(abortStream).toHaveBeenCalledTimes(1)
    preferredMic = "phone"
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(native.join.mock.calls[1]?.[0]).toMatchObject({audioSource: ACS_CALL_MIC})
    expect(state.audioSource).toBe(ACS_CALL_MIC)
    expect(state.audioSourceReason).toBe("explicit")
    expect(openStream).toHaveBeenCalledTimes(2)
  })

  test("audioSafety unsafe is logged and does not end the meeting", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    try {
      await acsMeetingService.join("com.mentra.call", {
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
        token: "tok",
        whepUrl: "https://example.com/whep",
      })
      native.emit("onState", {
        state: "connected",
        muted: false,
        audioSource: "glasses",
        activeStream: "none",
        audioSafety: "unsafe",
      })
    } finally {
      console.error = original
    }
    expect(acsMeetingService.getState()).toMatchObject({
      state: "connected",
      audioSafety: "unsafe",
    })
    expect(acsMeetingService.ownerPackage()).toBe("com.mentra.call")
    expect(native.leave).not.toHaveBeenCalled()
    expect(errors.some((args) => String(args[0]).includes("audio-unsafe"))).toBe(true)
  })
})
