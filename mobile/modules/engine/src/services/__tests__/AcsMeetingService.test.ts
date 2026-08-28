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

const openStream = mock(async () => {})
const abortStream = mock(async () => {})
const writeStreamChunk = mock(async () => {})
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

const {default: acsMeetingService, setAcsMeetingNativeForTests} = require("../AcsMeetingService") as typeof import("../AcsMeetingService")

type NativeJoin = {
  meetingUrl: string
  token: string
  whepUrl: string
  displayName?: string
  audioSource?: "glasses" | "phone"
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
  })

  afterEach(async () => {
    await acsMeetingService.leave("com.mentra.call")
    setAcsMeetingNativeForTests(undefined)
  })

  test("join passes the resolved audioSource and does not watch stores", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
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
    expect(settingsSubscribe).not.toHaveBeenCalled()
    expect(coreSubscribe).not.toHaveBeenCalled()
    expect(native.setAudioSource).not.toHaveBeenCalled()
  })

  test("a second join on a reused session does not inherit the previous audioSource", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    await acsMeetingService.leave("com.mentra.call")
    preferredMic = "phone"
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      whepUrl: "https://example.com/whep",
    })
    expect(native.join.mock.calls[1]?.[0]).toMatchObject({audioSource: "phone"})
    expect(state.audioSource).toBe("phone")
    expect(state.audioSourceReason).toBe("explicit")
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
