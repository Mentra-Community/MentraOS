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
import {reactNative} from "./reactNativeTestMock"

reactNative.Platform = {OS: "android"}
import {bluetoothSdk} from "./bluetoothSdkTestMock"

const {
  default: acsMeetingService,
  glassesLc3UplinkSupported,
  SOFTAP_LC3_AUDIO_DELAY_MS,
  pcmToBase64,
  parseAcsOutgoingVideo,
  parseAcsVideoSource,
  parseMeetingParticipants,
  ACS_CALL_MIC,
  GLASSES_MIC_UNAVAILABLE,
  resolveAcsAudioSource,
  setAcsMeetingNativeForTests,
  setAcsMeetingPhoneNetworkForTests,
  setSoftapBleLc3UplinkForTests,
} = require("../AcsMeetingService") as typeof import("../AcsMeetingService")

const micStateCoordinator = require("../MicStateCoordinator").default as {
  setCallRequirement(pcm: boolean): void
}

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
  videoSource: {type: string; url?: string; ssid?: string; passphrase?: string}
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
  const joinScopedNetwork = mock(async (_ssid: string, _passphrase: string) => "192.168.43.20")
  const leaveScopedNetwork = mock(async () => {})
  const getState = mock(async () => ({state: "idle" as const, muted: false}))
  return {
    join,
    leave,
    setMuted,
    setAudioSource,
    updateVideoSource,
    restartVideoSource,
    joinScopedNetwork,
    leaveScopedNetwork,
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
          videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
        videoSource: {type: "whep", url: "https://example.com/whep"},
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

  /**
   * The whole point of the second verb: native's `leave()` queues its hang-up and agent disposal
   * and returns, so a host that awaits it and then starts the next call is racing this call's
   * teardown through the same hotspot.
   */
  test("leaveAndAwait uses the native completion signal when the build has one", async () => {
    const native = fakeNative()
    const leaveAndAwait = mock(async (_options: {timeoutMs: number}) => ({completed: true}))
    setAcsMeetingNativeForTests({...native, leaveAndAwait})
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })

    await expect(acsMeetingService.leaveAndAwait("com.mentra.call", 1234)).resolves.toEqual({completed: true})

    expect(leaveAndAwait).toHaveBeenCalledWith({timeoutMs: 1234})
    expect(native.leave).not.toHaveBeenCalled()
    expect(acsMeetingService.ownerPackage()).toBeNull()
  })

  /** An older host still has to work — it just cannot promise the cleanup finished, and says so. */
  test("leaveAndAwait falls back to leave on a native that predates it and reports the weaker guarantee", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })

    await expect(acsMeetingService.leaveAndAwait("com.mentra.call")).resolves.toEqual({
      completed: false,
      reason: "unsupported",
    })

    expect(native.leave).toHaveBeenCalledTimes(1)
  })

  /** A cleanup failure must surface, not be reported as a clean teardown the next call can trust. */
  test("leaveAndAwait propagates a native cleanup failure and still releases host state", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests({
      ...native,
      leaveAndAwait: async () => {
        throw new Error("acs_leave_timeout")
      },
    })
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })

    await expect(acsMeetingService.leaveAndAwait("com.mentra.call")).rejects.toThrow("acs_leave_timeout")

    expect(acsMeetingService.ownerPackage()).toBeNull()
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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

  test("a SoftAP call does not rebuild ingest when the default route flaps onto cellular", async () => {
    // Joining the glasses hotspot is what *causes* NetInfo to report none → cellular. Rebuilding
    // the WHIP listener on that flap changes the ingest port after start_stream already went out,
    // and the glasses POST hits a tombstone (HTTP 410). A real hotspot loss is onScopedNetworkLost.
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    const network = fakePhoneNetwork()
    setAcsMeetingPhoneNetworkForTests(network)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap", ssid: "MentraLive_ce9cf6", passphrase: "x"},
    })
    network.emit({type: "none", isConnected: false})
    network.emit({type: "cellular", isConnected: true})
    await flush()
    expect(native.restartVideoSource).not.toHaveBeenCalled()
    expect(native.updateVideoSource).not.toHaveBeenCalled()
    await acsMeetingService.leave("com.mentra.call")
  })

  test("a native without restartVideoSource falls back to a same-URL updateVideoSource", async () => {
    const {restartVideoSource: _omitted, ...native} = fakeNative()
    setAcsMeetingNativeForTests(native)
    const network = fakePhoneNetwork()
    setAcsMeetingPhoneNetworkForTests(network)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })
    native.emit("onState", {
      state: "connected",
      muted: false,
      mediaSource: "failed",
      mediaSourceReason: "No host ICE candidate on the glasses hotspot",
    })
    expect(acsMeetingService.getState().mediaSource).toBe("failed")
    expect(acsMeetingService.getState().mediaSourceReason).toBe("No host ICE candidate on the glasses hotspot")
    native.emit("onState", {state: "connected", muted: false, mediaSource: "bogus"})
    expect(acsMeetingService.getState().mediaSource).toBeUndefined()
    expect(acsMeetingService.getState().mediaSourceReason).toBeUndefined()
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
      video,
    })
    expect(native.join).toHaveBeenCalledWith(expect.objectContaining({video}))
  })

  test("parseAcsOutgoingVideo accepts documented 16:9 sizes and rejects 540×960 and 854×480", () => {
    for (const fps of [15, 24, 30]) {
      expect(parseAcsOutgoingVideo({width: 858, height: 480, fps, maxBitrateBps: 1_000_000})).toEqual({
        width: 858, height: 480, fps, maxBitrateBps: 1_000_000,
      })
    }
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
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })
    await acsMeetingService.leave("com.mentra.call")
    expect(abortStream).toHaveBeenCalledTimes(1)
    preferredMic = "phone"
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
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
        videoSource: {type: "whep", url: "https://example.com/whep"},
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

  test("a SoftAP join sends the union and no WHEP URL", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)

    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })

    const options = native.join.mock.calls[0][0]
    expect(options.videoSource).toEqual({type: "softap"})
    // An empty legacy whepUrl is deliberate: a native that predates the union must fail its own
    // required-field check rather than subscribe to nothing and time out much later.
    expect(options.whepUrl).toBe("")
    await acsMeetingService.leave("com.mentra.call")
  })

  test("updateVideoSource is refused during a SoftAP call instead of silently doing nothing", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })

    await expect(
      acsMeetingService.updateVideoSource("com.mentra.call", "https://example.com/whep"),
    ).rejects.toThrow("SoftAP")
    expect(native.updateVideoSource).not.toHaveBeenCalled()
    await acsMeetingService.leave("com.mentra.call")
  })

  test("a default-network change does not rebuild a SoftAP feed", async () => {
    // SoftAP media is bound to the scoped hotspot. Joining that hotspot is what makes NetInfo
    // flap `none → cellular`, and rebuilding the WHIP listener on that flap changes the ingest
    // port after the glasses already have the old URL. A real hotspot loss is onScopedNetworkLost.
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    let emit: ((state: {type: string; isConnected: boolean | null}) => void) | null = null
    setAcsMeetingPhoneNetworkForTests({
      addEventListener: (listener) => {
        emit = listener
        return () => {}
      },
    })
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })

    emit!({type: "wifi", isConnected: true})
    emit!({type: "cellular", isConnected: true})
    await flush()

    expect(native.restartVideoSource).not.toHaveBeenCalled()
    await acsMeetingService.leave("com.mentra.call")
  })

  test("a WHEP join still sends the legacy whepUrl alongside the union", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)

    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "whep", url: "https://example.com/whep"},
    })

    const options = native.join.mock.calls[0][0]
    expect(options.whepUrl).toBe("https://example.com/whep")
    expect(options.videoSource).toEqual({type: "whep", url: "https://example.com/whep"})
    await acsMeetingService.leave("com.mentra.call")
  })
})

/**
 * The wearer's voice over BLE LC3 instead of the glasses' published WebRTC audio track.
 *
 * Two failures dominate this path and neither is visible from a state field: the phone microphone
 * opening alongside the glasses one (the room joins the meeting), and the call being heard twice
 * because the glasses kept publishing audio as well. Both are decided by *when* the transport is
 * chosen and *whether* the claims are released, so these tests assert on the calls, not the state.
 */
describe("glasses LC3 microphone uplink", () => {
  const pushOutgoingPcm = mock((_b64: string, _rate: number, _channels: number) => {})
  const setMicSourcePin = mock(async (_source: string | null) => {})
  let micListeners: Map<string, (event: Record<string, unknown>) => void>
  let previousSdk: {addListener: unknown; setMicSourcePin: unknown}

  type MicFrame = {pcm?: ArrayBuffer; sampleRate?: number; source?: string}

  const emitMic = (frame: MicFrame) => micListeners.get("mic_pcm")?.(frame as Record<string, unknown>)
  const pcm = (byte: number) => new Uint8Array([byte, byte, byte, byte]).buffer

  function lc3Native() {
    return {...fakeNative(), pushOutgoingPcm}
  }

  async function joinedOnSoftap(native: ReturnType<typeof lc3Native>) {
    setAcsMeetingNativeForTests(native)
    return acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })
  }

  beforeEach(() => {
    setSoftapBleLc3UplinkForTests(true)
    micListeners = new Map()
    pushOutgoingPcm.mockClear()
    setMicSourcePin.mockClear()
    previousSdk = {addListener: bluetoothSdk.addListener, setMicSourcePin: bluetoothSdk.setMicSourcePin}
    bluetoothSdk.setMicSourcePin = setMicSourcePin
    bluetoothSdk.addListener = (event: string, listener: (payload: Record<string, unknown>) => void) => {
      micListeners.set(event, listener)
      return {remove: () => micListeners.delete(event)}
    }
  })

  afterEach(async () => {
    await acsMeetingService.leave("com.mentra.call")
    setAcsMeetingNativeForTests(undefined)
    setSoftapBleLc3UplinkForTests(null)
    micStateCoordinator.setCallRequirement(false)
    bluetoothSdk.addListener = previousSdk.addListener
    bluetoothSdk.setMicSourcePin = previousSdk.setMicSourcePin
  })

  test("the gate needs Android, SoftAP, the glasses mic, and a native that can take PCM", () => {
    const softap = {type: "softap"} as const
    const supported = {
      videoSource: softap,
      audioSource: "glasses" as const,
      hasPushOutgoingPcm: true,
      platform: "android",
    }
    expect(glassesLc3UplinkSupported(supported)).toBe(true)
    // iOS has no mic pin, so it cannot promise the phone microphone stays shut.
    expect(glassesLc3UplinkSupported({...supported, platform: "ios"})).toBe(false)
    // WHEP audio arrives already mixed into the subscribed track; there is nothing to turn off.
    expect(
      glassesLc3UplinkSupported({...supported, videoSource: {type: "whep", url: "https://x/whep"}}),
    ).toBe(false)
    expect(glassesLc3UplinkSupported({...supported, audioSource: "phone"})).toBe(false)
    // An older Mentra App keeps the audio track it has always used rather than joining mute.
    expect(glassesLc3UplinkSupported({...supported, hasPushOutgoingPcm: false})).toBe(false)
  })

  test("a SoftAP join pins the glasses mic and reports the BLE transport", async () => {
    const native = lc3Native()
    const state = await joinedOnSoftap(native)

    expect(setMicSourcePin).toHaveBeenCalledWith("glasses")
    expect(state.micTransport).toBe("ble-lc3")
    expect(acsMeetingService.glassesLc3UplinkActive()).toBe(true)
    expect(micListeners.has("mic_pcm")).toBe(true)
    expect(native.join).toHaveBeenCalledWith(
      expect.objectContaining({audioDelayMs: SOFTAP_LC3_AUDIO_DELAY_MS}),
    )
  })

  test("a host that cannot take PCM keeps the published audio track and never pins", async () => {
    const {pushOutgoingPcm: _absent, ...native} = lc3Native()
    setAcsMeetingNativeForTests(native)

    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })

    expect(state.micTransport).toBe("whip")
    expect(acsMeetingService.glassesLc3UplinkActive()).toBe(false)
    expect(setMicSourcePin).not.toHaveBeenCalled()
    expect(micListeners.has("mic_pcm")).toBe(false)
    expect(native.join.mock.calls[0]?.[0]).not.toHaveProperty("audioDelayMs")
  })

  /**
   * Hermes has no Node `Buffer`. A live SoftAP call selected `ble-lc3` and then threw
   * `Property 'Buffer' doesn't exist` on every frame, so Teams heard a minute of silence
   * while the glasses mic was running at ~100 events/s.
   */
  test("pcmToBase64 does not need Node Buffer and matches its encoding", () => {
    const bytes = new Uint8Array(320).fill(0x20)
    const expected = Buffer.from(bytes).toString("base64")
    const saved = (globalThis as {Buffer?: unknown}).Buffer
    try {
      // @ts-expect-error — simulate the phone
      delete (globalThis as {Buffer?: unknown}).Buffer
      expect(pcmToBase64(bytes.buffer)).toBe(expected)
    } finally {
      if (saved) (globalThis as {Buffer?: unknown}).Buffer = saved
    }
  })

  test("glasses frames reach native as base64 at their own sample rate", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)

    emitMic({pcm: pcm(0x01), sampleRate: 16000, source: "glasses"})
    emitMic({pcm: pcm(0x02), sampleRate: 16000, source: "glasses"})

    expect(pushOutgoingPcm).toHaveBeenCalledTimes(2)
    expect(pushOutgoingPcm.mock.calls[0]).toEqual([Buffer.from([1, 1, 1, 1]).toString("base64"), 16000, 1])
    expect(pushOutgoingPcm.mock.calls[1]?.[0]).toBe(Buffer.from([2, 2, 2, 2]).toString("base64"))
  })

  /**
   * The bridge hands `mic_pcm.pcm` over as a Uint8Array on Hermes, not an ArrayBuffer. The
   * encoder has to take both or a live call pushes garbage while the unit tests (which build
   * ArrayBuffers) stay green.
   */
  test("a Uint8Array frame is forwarded byte-for-byte", async () => {
    await joinedOnSoftap(lc3Native())

    emitMic({pcm: new Uint8Array([9, 9, 9, 9]) as unknown as ArrayBuffer, sampleRate: 16000, source: "glasses"})

    expect(pushOutgoingPcm).toHaveBeenCalledTimes(1)
    expect(pushOutgoingPcm.mock.calls[0]?.[0]).toBe(Buffer.from([9, 9, 9, 9]).toString("base64"))
  })

  /**
   * Frame rate alone was what fooled the last soak: 20 Hz of the noise floor and 20 Hz of speech
   * log identically. The health line has to carry level. This drives the log window by faking
   * the clock, since the interval is 5 s.
   */
  test("the uplink health line reports the PCM level of the window", async () => {
    await joinedOnSoftap(lc3Native())
    const loud = new Uint8Array(4)
    new DataView(loud.buffer).setInt16(0, 3000, true)
    new DataView(loud.buffer).setInt16(2, -1000, true)
    const realNow = Date.now
    const logs: unknown[] = []
    const realLog = console.log
    console.log = (...args: unknown[]) => {
      if (args[0] === "[AcsMeeting] phase=glasses-mic-uplink") logs.push(args[1])
    }
    try {
      emitMic({pcm: loud.buffer, sampleRate: 16000, source: "glasses"})
      // Cross the 5 s log interval on the next frame.
      const t0 = realNow()
      Date.now = () => t0 + 6000
      emitMic({pcm: pcm(0x00), sampleRate: 16000, source: "glasses"})
    } finally {
      Date.now = realNow
      console.log = realLog
    }

    expect(logs).toHaveLength(1)
    // (3000 + 1000 + 0 + 0) / 4 samples
    expect(logs[0]).toMatchObject({meanAbs: 1000, peak: 3000, frames: 2})
    expect(acsMeetingService.lastGlassesMicLevel()).toEqual({meanAbs: 1000, peak: 3000})
  })

  /**
   * The pin makes this unreachable in normal operation, which is why it is worth a test: if the SDK
   * ever moves the microphone under a live call, the wrong answer is to carry on. That would put
   * the room the wearer is standing in onto a Teams call that still reports "glasses".
   */
  test("a frame from another microphone is dropped, never forwarded", async () => {
    await joinedOnSoftap(lc3Native())
    const original = console.error
    console.error = () => {}
    try {
      emitMic({pcm: pcm(0x03), sampleRate: 16000, source: "phone"})
    } finally {
      console.error = original
    }

    expect(pushOutgoingPcm).not.toHaveBeenCalled()
  })

  test("a pinned mic that stops delivering is reported rather than replaced by the phone", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    const seen: string[] = []
    acsMeetingService.setStateHandler((_pkg, state) => seen.push(String(state.error)))
    const original = console.error
    console.error = () => {}
    try {
      // Inside the grace window a stray frame is not yet a failure: the glasses mic may still be
      // opening. Past it, with no glasses frame since, the call has no wearer audio at all.
      emitMic({pcm: pcm(0x04), source: "phone"})
      expect(acsMeetingService.getState().micTransport).toBe("ble-lc3")
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      emitMic({pcm: pcm(0x04), source: "phone"})
    } finally {
      console.error = original
      acsMeetingService.setStateHandler(() => {})
    }

    expect(acsMeetingService.getState().micTransport).toBe("none")
    expect(seen).toContain(GLASSES_MIC_UNAVAILABLE)
    expect(pushOutgoingPcm).not.toHaveBeenCalled()
  })

  test("leave releases the pin and the listener, and late frames go nowhere", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    const listener = micListeners.get("mic_pcm")!

    await acsMeetingService.leave("com.mentra.call")

    expect(setMicSourcePin).toHaveBeenLastCalledWith(null)
    expect(micListeners.has("mic_pcm")).toBe(false)
    expect(acsMeetingService.glassesLc3UplinkActive()).toBe(false)
    // A frame already queued on the JS thread when the call ended still runs; the generation check
    // is what stops it reaching a native session that has left the meeting.
    listener({pcm: pcm(0x05), sampleRate: 16000, source: "glasses"})
    expect(pushOutgoingPcm).not.toHaveBeenCalled()
  })

  /**
   * A remote hang-up never goes through `leave`. Without a release on the terminal native state the
   * pin outlives the meeting, and the next call — or the captions miniapp — inherits a microphone
   * it cannot reassign.
   */
  test("a remote hang-up releases the pin, and the leave that follows it does not double-release", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    setMicSourcePin.mockClear()

    native.emit("onState", {state: "disconnected", muted: false})
    await flush()

    expect(setMicSourcePin).toHaveBeenCalledTimes(1)
    expect(setMicSourcePin).toHaveBeenCalledWith(null)
    expect(micListeners.has("mic_pcm")).toBe(false)

    await acsMeetingService.leave("com.mentra.call")
    expect(setMicSourcePin).toHaveBeenCalledTimes(1)
  })

  test("a terminal error releases the pin and keeps the reason on the state", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    setMicSourcePin.mockClear()

    native.emit("onState", {state: "error", muted: false, error: "ACS_TOKEN_EXPIRED"})
    await flush()

    expect(setMicSourcePin).toHaveBeenCalledWith(null)
    expect(micListeners.has("mic_pcm")).toBe(false)
  })

  test("a second terminal state is a no-op rather than a second release", async () => {
    // Two `disconnected` events for one call are ordinary; releasing twice would clear a pin the
    // *next* call had already taken.
    const native = lc3Native()
    await joinedOnSoftap(native)
    setMicSourcePin.mockClear()

    native.emit("onState", {state: "disconnected", muted: false})
    native.emit("onState", {state: "disconnected", muted: false})
    await flush()

    expect(setMicSourcePin).toHaveBeenCalledTimes(1)
  })

  /** End can fail and still have left this device; the claims have to go either way. */
  test("a rejected endForEveryone still releases the microphone claims", async () => {
    const native = {
      ...lc3Native(),
      endForEveryone: mock(async () => {
        throw new Error("ACS refused the hang-up")
      }),
    }
    await joinedOnSoftap(native)
    setMicSourcePin.mockClear()

    await expect(acsMeetingService.endForEveryone("com.mentra.call")).rejects.toThrow("refused")

    expect(setMicSourcePin).toHaveBeenCalledWith(null)
    expect(micListeners.has("mic_pcm")).toBe(false)
    expect(acsMeetingService.ownerPackage()).toBeNull()
  })

  test("a miniapp stopping releases the claims through leaveIfOwner", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    setMicSourcePin.mockClear()

    // Another miniapp stopping must not touch this call.
    await acsMeetingService.leaveIfOwner("com.other.app")
    expect(setMicSourcePin).not.toHaveBeenCalled()

    await acsMeetingService.leaveIfOwner("com.mentra.call")
    expect(setMicSourcePin).toHaveBeenCalledWith(null)
    expect(micListeners.has("mic_pcm")).toBe(false)
  })

  test("a leave during the ACS join cancels it and leaves no microphone claim behind", async () => {
    const native = lc3Native()
    let releaseJoin: (() => void) | null = null
    native.join.mockImplementationOnce(async (options: NativeJoin) => {
      await new Promise<void>((resolve) => {
        releaseJoin = resolve
      })
      return {
        state: "connected" as const,
        muted: false,
        provider: "acs-teams" as const,
        audioSource: options.audioSource,
        activeStream: "virtual" as const,
        audioSafety: "safe" as const,
      }
    })
    setAcsMeetingNativeForTests(native)
    const original = console.warn
    console.warn = () => {}
    try {
      const joining = acsMeetingService.join("com.mentra.call", {
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
        token: "tok",
        videoSource: {type: "softap"},
      })
      await flush()
      await acsMeetingService.leave("com.mentra.call")
      releaseJoin!()

      await expect(joining).rejects.toThrow("cancelled")
    } finally {
      console.warn = original
    }

    // Nothing above knows about this call, so hanging it up here is the only thing that takes the
    // device out of the Teams roster — and the uplink must never have started.
    expect(native.leave).toHaveBeenCalled()
    expect(micListeners.has("mic_pcm")).toBe(false)
    expect(pushOutgoingPcm).not.toHaveBeenCalled()
    expect(acsMeetingService.ownerPackage()).toBeNull()
  })

  test("a rejoin takes the pin again and forwards on the new generation", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)
    const stale = micListeners.get("mic_pcm")!
    await acsMeetingService.leave("com.mentra.call")

    const state = await joinedOnSoftap(native)

    expect(state.micTransport).toBe("ble-lc3")
    expect(setMicSourcePin.mock.calls.map((call) => call[0])).toEqual(["glasses", null, "glasses"])
    // The previous call's listener was removed; only the current one forwards.
    stale({pcm: pcm(0x06), sampleRate: 16000, source: "glasses"})
    emitMic({pcm: pcm(0x07), sampleRate: 16000, source: "glasses"})
    expect(pushOutgoingPcm).toHaveBeenCalledTimes(1)
    expect(pushOutgoingPcm.mock.calls[0]?.[0]).toBe(Buffer.from([7, 7, 7, 7]).toString("base64"))
  })

  test("mute does not change the transport", async () => {
    const native = lc3Native()
    await joinedOnSoftap(native)

    const state = await acsMeetingService.setMuted("com.mentra.call", true)

    // Mute is an ACS-side gate; the glasses microphone stays open and pinned.
    expect(state.micTransport).toBe("ble-lc3")
    expect(setMicSourcePin).toHaveBeenCalledTimes(1)
    emitMic({pcm: pcm(0x08), sampleRate: 16000, source: "glasses"})
    expect(pushOutgoingPcm).toHaveBeenCalledTimes(1)
  })

  test("a subscribe failure downgrades the call instead of failing it", async () => {
    bluetoothSdk.addListener = () => {
      throw new Error("BLE SDK is not ready")
    }
    const native = lc3Native()
    const original = console.error
    console.error = () => {}
    let state: Awaited<ReturnType<typeof acsMeetingService.join>>
    try {
      state = await joinedOnSoftap(native)
    } finally {
      console.error = original
    }

    // Connected, and honest about it: the miniapp learns from the join itself that nobody can
    // hear the wearer, instead of discovering it when someone asks them to repeat themselves.
    expect(state.state).toBe("connected")
    expect(state.micTransport).toBe("none")
    expect(state.error).toBe(GLASSES_MIC_UNAVAILABLE)
    expect(acsMeetingService.getState().micTransport).toBe("none")
    expect(acsMeetingService.ownerPackage()).toBe("com.mentra.call")
    expect(native.leave).not.toHaveBeenCalled()
  })
})

/**
 * Production SoftAP ships BLE LC3 — with the *default* gate, not the test seam. The suite above
 * turns the seam on explicitly; this one proves nobody has to. A build that quietly flips the
 * constant back is a build whose SoftAP calls open the glasses SoC microphone again.
 */
describe("SoftAP microphone transport (production default)", () => {
  let previousSdk: {addListener: unknown; setMicSourcePin: unknown}

  beforeEach(() => {
    previousSdk = {addListener: bluetoothSdk.addListener, setMicSourcePin: bluetoothSdk.setMicSourcePin}
    bluetoothSdk.setMicSourcePin = mock(async (_source: string | null) => {})
    bluetoothSdk.addListener = () => ({remove: () => {}})
  })

  afterEach(async () => {
    await acsMeetingService.leave("com.mentra.call")
    setAcsMeetingNativeForTests(undefined)
    setSoftapBleLc3UplinkForTests(null)
    micStateCoordinator.setCallRequirement(false)
    bluetoothSdk.addListener = previousSdk.addListener
    bluetoothSdk.setMicSourcePin = previousSdk.setMicSourcePin
  })

  test("ships BLE LC3 on SoftAP without any test seam", async () => {
    setSoftapBleLc3UplinkForTests(null)
    const supported = {
      videoSource: {type: "softap"} as const,
      audioSource: "glasses" as const,
      hasPushOutgoingPcm: true,
      platform: "android",
    }
    expect(glassesLc3UplinkSupported(supported)).toBe(true)

    const native = {...fakeNative(), pushOutgoingPcm: mock(() => {})}
    setAcsMeetingNativeForTests(native)
    const state = await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })

    expect(state.micTransport).toBe("ble-lc3")
    expect(acsMeetingService.glassesLc3UplinkActive()).toBe(true)
  })

  test("the seam can still turn it off for a soak comparison", () => {
    setSoftapBleLc3UplinkForTests(false)
    expect(
      glassesLc3UplinkSupported({
        videoSource: {type: "softap"},
        audioSource: "glasses",
        hasPushOutgoingPcm: true,
        platform: "android",
      }),
    ).toBe(false)
  })
})

describe("parseAcsVideoSource", () => {
  test("accepts both transports and trims the WHEP URL", () => {
    expect(parseAcsVideoSource({type: "whep", url: " https://example.com/whep "})).toEqual({
      type: "whep",
      url: "https://example.com/whep",
    })
    expect(parseAcsVideoSource({type: "softap"})).toEqual({type: "softap"})
    expect(parseAcsVideoSource({type: "softap", ssid: "MentraLive-1", passphrase: "pw"})).toEqual({
      type: "softap",
      ssid: "MentraLive-1",
      passphrase: "pw",
    })
  })

  test("rejects an unknown transport rather than defaulting to WHEP", () => {
    // Defaulting here is how a miniapp asking for SoftAP quietly gets a Cloudflare call.
    expect(() => parseAcsVideoSource({type: "direct"})).toThrow("unsupported videoSource.type")
  })

  test("rejects a missing or malformed source", () => {
    for (const input of [undefined, null, "whep", 7, {}, {type: "whep"}, {type: "whep", url: " "}]) {
      expect(() => parseAcsVideoSource(input)).toThrow()
    }
  })

  test("rejects half a SoftAP credential pair", () => {
    expect(() => parseAcsVideoSource({type: "softap", ssid: "MentraLive-1"})).toThrow("together")
    expect(() => parseAcsVideoSource({type: "softap", passphrase: "pw"})).toThrow("together")
  })
})

describe("scoped network passthrough", () => {
  afterEach(() => {
    setAcsMeetingNativeForTests(undefined)
  })

  test("the hotspot join returns this phone's address on the SoftAP subnet", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)

    await expect(acsMeetingService.joinScopedNetwork("MentraLive-1234", "hunter2!")).resolves.toBe("192.168.43.20")
    expect(native.joinScopedNetwork).toHaveBeenCalledWith("MentraLive-1234", "hunter2!")
  })

  test("iOS verifies DHCP against the gateway from the glasses instead of using the legacy join", async () => {
    const native = fakeNative()
    const joinScopedNetworkWithGateway = mock(
      async (_ssid: string, _password: string, _gateway: string) => "192.168.43.142",
    )
    setAcsMeetingNativeForTests({...native, joinScopedNetworkWithGateway})
    await expect(acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw", "192.168.43.1")).resolves.toBe(
      "192.168.43.142",
    )
    expect(joinScopedNetworkWithGateway).toHaveBeenCalledWith("MentraLive-1234", "pw", "192.168.43.1")
    expect(native.joinScopedNetwork).not.toHaveBeenCalled()
    await expect(acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw")).rejects.toThrow("hotspot gateway")
    expect(joinScopedNetworkWithGateway).toHaveBeenCalledTimes(1)
  })

  test("a host that cannot join the hotspot says so instead of skipping the join", async () => {
    // Silently resolving here is the dangerous case: the sequence would go on to an ACS join and a
    // glasses publish with no network to meet on, and surface as a black tile several steps later.
    const native = fakeNative()
    setAcsMeetingNativeForTests({...native, joinScopedNetwork: undefined} as never)

    await expect(acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw")).rejects.toThrow("SoftAP calling")
  })

  test("releasing is safe on a host with no scoped-network support", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests({...native, leaveScopedNetwork: undefined} as never)

    await expect(acsMeetingService.leaveScopedNetwork()).resolves.toBeUndefined()
  })

  test("prepareAgent signs in before SoftAP when the native method exists", async () => {
    const prepareAgent = mock(async () => ({state: "connecting" as const, muted: false}))
    const native = {...fakeNative(), prepareAgent}
    setAcsMeetingNativeForTests(native)

    await acsMeetingService.prepareAgent({token: "tok", displayName: "Mentra Call"})
    expect(prepareAgent).toHaveBeenCalledWith({token: "tok", displayName: "Mentra Call"})
  })

  test("prepareAgent is a no-op on a host that predates it", async () => {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)

    await expect(acsMeetingService.prepareAgent({token: "tok"})).resolves.toBeUndefined()
  })
})

/**
 * Mid-call hotspot loss, and the false positive that goes with it.
 *
 * Android reports the scoped network going away whether we walked out of range or asked for it to
 * go away, so the honest signal depends entirely on intent: a loss is only a failure while the call
 * is still supposed to be running.
 */
describe("scoped network loss", () => {
  afterEach(async () => {
    await acsMeetingService.leaveScopedNetwork()
    setAcsMeetingNativeForTests(undefined)
  })

  async function joinedScoped() {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw")
    return native
  }

  test("an unexpected loss reaches every subscriber", async () => {
    const native = await joinedScoped()
    const seen: Array<{code: string; message: string}> = []
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "network onLost"})

    expect(seen).toEqual([{code: "SOFTAP_NETWORK_LOST", message: "network onLost"}])
  })

  /** The bug this guard exists for: Leave manufacturing the error it is in the middle of avoiding. */
  test("the loss we asked for is not reported", async () => {
    const native = await joinedScoped()
    const seen: unknown[] = []
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    acsMeetingService.beginScopedTeardown()
    native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "released"})

    expect(seen).toEqual([])
  })

  /** Intent must be raised before the release, not after it, or the callback wins the race. */
  test("leaveScopedNetwork raises the intent before it releases", async () => {
    const native = fakeNative()
    const seen: unknown[] = []
    let lostDuringRelease = false
    native.leaveScopedNetwork.mockImplementationOnce(async () => {
      native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "released"})
      lostDuringRelease = true
    })
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw")
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    await acsMeetingService.leaveScopedNetwork()

    expect(lostDuringRelease).toBe(true)
    expect(seen).toEqual([])
  })

  test("a fresh join clears the previous call's terminal intent", async () => {
    const native = await joinedScoped()
    acsMeetingService.beginScopedTeardown()
    const seen: unknown[] = []
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    await acsMeetingService.joinScopedNetwork("MentraLive-1234", "pw")
    native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "network onLost"})

    expect(seen).toHaveLength(1)
  })

  test("unsubscribing stops delivery", async () => {
    const native = await joinedScoped()
    const seen: unknown[] = []
    const unsubscribe = acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    unsubscribe()
    native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "network onLost"})

    expect(seen).toEqual([])
  })

  /** One subscriber throwing must not swallow the loss for the one that would act on it. */
  test("a throwing subscriber does not stop the others", async () => {
    const native = await joinedScoped()
    const seen: unknown[] = []
    acsMeetingService.onScopedNetworkLost(() => {
      throw new Error("listener exploded")
    })
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))
    const originalWarn = console.warn
    console.warn = () => {}

    try {
      native.emit("onScopedNetworkLost", {code: "SOFTAP_NETWORK_LOST", message: "network onLost"})
    } finally {
      console.warn = originalWarn
    }

    expect(seen).toHaveLength(1)
  })

  test("a malformed native event still names the failure", async () => {
    const native = await joinedScoped()
    const seen: Array<{code: string; message: string}> = []
    acsMeetingService.onScopedNetworkLost((error) => seen.push(error))

    native.emit("onScopedNetworkLost", {})

    expect(seen[0]).toEqual({code: "SOFTAP_NETWORK_LOST", message: "The glasses hotspot went away"})
  })
})

describe("waitForFirstFrame", () => {
  afterEach(async () => {
    await acsMeetingService.leave("com.mentra.call")
    setAcsMeetingNativeForTests(undefined)
  })

  async function joinedNative() {
    const native = fakeNative()
    setAcsMeetingNativeForTests(native)
    await acsMeetingService.join("com.mentra.call", {
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      token: "tok",
      videoSource: {type: "softap"},
    })
    return native
  }

  test("resolves when the host reports a frame reached ACS", async () => {
    const native = await joinedNative()
    const waiting = acsMeetingService.waitForFirstFrame(1_000)

    native.emit("onState", {state: "connected", muted: false, mediaSource: "live"})

    await expect(waiting).resolves.toBeUndefined()
  })

  test("rejects when the feed fails rather than waiting out the timeout", async () => {
    const native = await joinedNative()
    const waiting = acsMeetingService.waitForFirstFrame(60_000)

    native.emit("onState", {state: "connected", muted: false, mediaSource: "failed"})

    await expect(waiting).rejects.toThrow("failed")
  })

  test("a connecting feed is not a first frame", async () => {
    // An ACS join says nothing about video. Treating `connecting` as success is what reports a
    // black call as live.
    const native = await joinedNative()
    let settled = false
    const waiting = acsMeetingService.waitForFirstFrame(60_000).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    native.emit("onState", {state: "connected", muted: false, mediaSource: "connecting"})
    await flush()
    expect(settled).toBe(false)

    native.emit("onState", {state: "connected", muted: false, mediaSource: "live"})
    await waiting
    expect(settled).toBe(true)
  })

  test("rejects on timeout naming the wait in seconds", async () => {
    await joinedNative()

    await expect(acsMeetingService.waitForFirstFrame(10)).rejects.toThrow("within")
  })

  test("a leave mid-wait rejects the waiter instead of stranding it", async () => {
    // Without this, a user leaving during the join would leave the orchestrator parked for the full
    // first-frame timeout before it could unwind.
    await joinedNative()
    const waiting = acsMeetingService.waitForFirstFrame(60_000)

    await acsMeetingService.leave("com.mentra.call")

    await expect(waiting).rejects.toThrow("ended")
  })

  test("a feed already live resolves without waiting for another event", async () => {
    const native = await joinedNative()
    native.emit("onState", {state: "connected", muted: false, mediaSource: "live"})

    await expect(acsMeetingService.waitForFirstFrame(0)).resolves.toBeUndefined()
  })
})
