/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import {reactNative} from "./reactNativeTestMock"

reactNative.Platform = {OS: "android"}
reactNative.Alert = {alert: () => {}}

import {bluetoothSdk} from "./bluetoothSdkTestMock"

const setCallRequirement = mock((_pcm: boolean) => {})
mock.module("../MicStateCoordinator", () => ({
  default: {setCallRequirement},
}))

const openStream = mock(async () => {})
const abortStream = mock(async () => {})
const writeStreamChunk = mock(async () => ({bufferedMs: 0}))
mock.module("../AudioPlaybackService", () => ({
  default: {openStream, abortStream, writeStreamChunk},
}))

// Timers never fire in these tests; the probe is stopped explicitly.
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  },
}))

const settingsState: Record<string, unknown> = {preferred_mic: "auto"}
const setSetting = mock(async (key: string, value: unknown) => {
  settingsState[key] = value
})
mock.module("../../stores/settings", () => ({
  SETTINGS: {preferred_mic: {key: "preferred_mic"}},
  useSettingsStore: {
    getState: () => ({
      getSetting: (key: string) => settingsState[key],
      setSetting,
    }),
  },
}))

const {parseMicProbeParams, pcmDataView, summarizePcm16, default: glassesMicProbe} =
  require("../GlassesMicProbe") as typeof import("../GlassesMicProbe")

function pcm16(...samples: number[]): ArrayBuffer {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  return bytes.buffer
}

describe("parseMicProbeParams", () => {
  test("reads a clean query", () => {
    expect(parseMicProbeParams({seconds: "15", a2dp: "tone", level: "0.4"})).toEqual({
      durationMs: 15000,
      a2dp: "tone",
      toneLevel: 0.4,
      source: "glasses",
    })
  })

  test("strips the adb-escaped seconds=15\\ leftover", () => {
    expect(parseMicProbeParams({seconds: "15\\", a2dp: "none"})).toEqual({
      durationMs: 15000,
      a2dp: "none",
      toneLevel: 0.2,
      source: "glasses",
    })
  })

  test("falls back when seconds is missing", () => {
    expect(parseMicProbeParams({}).durationMs).toBe(20000)
  })

  test("mic=phone selects the control run; anything else is the glasses", () => {
    expect(parseMicProbeParams({mic: "phone"}).source).toBe("phone")
    expect(parseMicProbeParams({mic: "bluetooth"}).source).toBe("glasses")
    expect(parseMicProbeParams({}).source).toBe("glasses")
  })
})

describe("pcmDataView / summarizePcm16", () => {
  test("accepts ArrayBuffer", () => {
    const stats = summarizePcm16([pcm16(0, 100, -100)])
    expect(stats.samples).toBe(3)
    expect(stats.peak).toBe(100)
    expect(stats.meanAbs).toBe(67)
  })

  test("accepts the Uint8Array the Expo bridge actually delivers", () => {
    const buffer = pcm16(0, 200, -50)
    const view = new Uint8Array(buffer)
    expect(pcmDataView(view)).toBeInstanceOf(DataView)
    const stats = summarizePcm16([view])
    expect(stats.samples).toBe(3)
    expect(stats.peak).toBe(200)
    expect(stats.meanAbs).toBe(83)
  })

  test("accepts a subarray so a pooled native buffer still measures the right bytes", () => {
    const padded = new Uint8Array(8)
    const view = new DataView(padded.buffer)
    view.setInt16(2, 300, true)
    view.setInt16(4, -20, true)
    const stats = summarizePcm16([padded.subarray(2, 6)])
    expect(stats.samples).toBe(2)
    expect(stats.peak).toBe(300)
  })

  test("skips unreadable frames instead of throwing", () => {
    expect(summarizePcm16([null, 12, "nope"])).toEqual({meanAbs: 0, peak: 0, samples: 0})
  })
})

describe("GlassesMicProbe start/stop race", () => {
  let pinResolve: (() => void) | undefined
  let addListener = mock(() => ({remove: () => {}}))

  beforeEach(() => {
    pinResolve = undefined
    addListener = mock(() => ({remove: () => {}}))
    bluetoothSdk.setMicSourcePin = mock((source: string | null) => {
      if (source == null) return Promise.resolve()
      return new Promise<void>((resolve) => {
        pinResolve = resolve
      })
    })
    bluetoothSdk.addListener = addListener
    setCallRequirement.mockClear()
  })

  afterEach(async () => {
    pinResolve?.()
    await glassesMicProbe.stop()
  })

  test("a stop during pin does not re-arm the mic listener", async () => {
    const started = glassesMicProbe.start({durationMs: 5000, a2dp: "none"})
    await glassesMicProbe.stop()
    pinResolve?.()
    await started
    expect(glassesMicProbe.isRunning()).toBe(false)
    expect(addListener).not.toHaveBeenCalled()
    expect(setCallRequirement).not.toHaveBeenCalledWith(true)
  })
})

/**
 * The control run. It exists to answer "is the room quiet or is the glasses pipe dead?" — so it
 * must measure the phone and must leave the user's microphone preference the way it found it,
 * or a dev probe silently moves captions onto the phone.
 */
describe("GlassesMicProbe phone control run", () => {
  let listeners: Map<string, (event: {pcm?: unknown; source?: string}) => void>

  beforeEach(() => {
    listeners = new Map()
    settingsState.preferred_mic = "glasses"
    setSetting.mockClear()
    setCallRequirement.mockClear()
    bluetoothSdk.setMicSourcePin = mock(async () => {})
    bluetoothSdk.addListener = mock((event: string, listener: (e: {pcm?: unknown; source?: string}) => void) => {
      listeners.set(event, listener)
      return {remove: () => listeners.delete(event)}
    })
  })

  afterEach(async () => {
    await glassesMicProbe.stop()
  })

  test("does not pin, steers preferred_mic to the phone, and restores it on stop", async () => {
    await glassesMicProbe.start({durationMs: 5000, a2dp: "none", source: "phone"})

    expect(bluetoothSdk.setMicSourcePin).not.toHaveBeenCalled()
    expect(setSetting).toHaveBeenCalledWith("preferred_mic", "phone", false)
    expect(setCallRequirement).toHaveBeenCalledWith(true)

    await glassesMicProbe.stop()

    expect(setSetting).toHaveBeenLastCalledWith("preferred_mic", "glasses", false)
    expect(settingsState.preferred_mic).toBe("glasses")
    expect(bluetoothSdk.setMicSourcePin).not.toHaveBeenCalled()
  })

  test("counts phone frames and rejects the glasses in phone mode", async () => {
    await glassesMicProbe.start({durationMs: 5000, a2dp: "none", source: "phone"})
    const seen: Array<{frames: number; nonGlasses: number; source: string}> = []
    const unsubscribe = glassesMicProbe.subscribe((sample) =>
      seen.push({frames: sample.frames, nonGlasses: sample.nonGlasses, source: sample.source}),
    )
    listeners.get("mic_pcm")?.({pcm: pcm16(100), source: "phone"})
    listeners.get("mic_pcm")?.({pcm: pcm16(100), source: "glasses"})
    await glassesMicProbe.stop()
    unsubscribe()

    expect(seen.at(-1)).toEqual({frames: 1, nonGlasses: 1, source: "glasses"})
  })
})
