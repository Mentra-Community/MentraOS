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
  resolveAcsAudioSource,
  setAcsMeetingNativeForTests,
} = require("../AcsMeetingService") as typeof import("../AcsMeetingService")

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
  const getState = mock(async () => ({state: "idle" as const, muted: false}))
  return {
    join,
    leave,
    setMuted,
    setAudioSource,
    updateVideoSource,
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
  })

  test("the call microphone is always the glasses, regardless of preferred_mic", () => {
    for (const mic of ["glasses", "phone", "bluetooth", "auto", ""]) {
      preferredMic = mic
      expect(resolveAcsAudioSource()).toEqual({source: "glasses", reason: "explicit"})
    }
  })

  test("join passes the glasses audioSource, opens 16 kHz mono playback, and does not watch stores", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    preferredMic = "phone"
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(native.join).toHaveBeenCalledWith(
      expect.objectContaining({audioSource: "glasses"}),
    )
    expect(state.audioSource).toBe("glasses")
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
    expect(native.join.mock.calls[1]?.[0]).toMatchObject({audioSource: "glasses"})
    expect(state.audioSource).toBe("glasses")
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
