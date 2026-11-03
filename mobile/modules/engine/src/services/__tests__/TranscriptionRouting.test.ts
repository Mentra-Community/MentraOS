/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  needsCloud,
  handoffStep,
  needsLocal,
  onDeviceServes,
  readSpeechProcessing,
  SOURCE_QUIET_MS,
  targetSource,
  UTTERANCE_STALE_MS,
  UtteranceTracker,
  type SpeechProcessing,
  type TranscriptionRoutingState,
} from "../TranscriptionRouting"

const state = (overrides: Partial<TranscriptionRoutingState> = {}): TranscriptionRoutingState => ({
  cloudConnected: true,
  onDevice: true,
  localLanguage: "en-US",
  pickedLanguage: "en-US",
  hints: [],
  ...overrides,
})
const listener = (processing: SpeechProcessing, stream = "transcription:auto") => ({processing, stream})

describe("reading processing", () => {
  test("processing wins; forceLocal alone means localOnly; anything else is preferCloud", () => {
    expect(readSpeechProcessing({processing: "preferLocal", forceLocal: true})).toBe("preferLocal")
    expect(readSpeechProcessing({forceLocal: true})).toBe("localOnly")
    expect(readSpeechProcessing({processing: "someday", forceLocal: true})).toBe("localOnly")
    expect(readSpeechProcessing({processing: "someday"})).toBe("preferCloud")
    expect(readSpeechProcessing({})).toBe("preferCloud")
  })
})

describe("target source", () => {
  test("preferCloud uses the cloud, and on-device only while the cloud is down", () => {
    expect(targetSource(listener("preferCloud"), state())).toBe("cloud")
    expect(targetSource(listener("preferCloud"), state({cloudConnected: false}))).toBe("local")
  })

  test("localOnly is always on-device", () => {
    expect(targetSource(listener("localOnly"), state({localLanguage: null}))).toBe("local")
    expect(targetSource(listener("localOnly", "transcription:fr-FR"), state())).toBe("local")
  })

  test("preferLocal is on-device only while a model in its language runs", () => {
    expect(targetSource(listener("preferLocal", "transcription:en-US"), state())).toBe("local")
    expect(targetSource(listener("preferLocal", "transcription:fr-FR"), state())).toBe("cloud")
    expect(targetSource(listener("preferLocal"), state({localLanguage: null}))).toBe("cloud")
    expect(targetSource(listener("preferLocal"), state({onDevice: false}))).toBe("cloud")
    // Like preferCloud, it falls back on-device while the cloud is down.
    expect(targetSource(listener("preferLocal", "transcription:fr-FR"), state({cloudConnected: false}))).toBe("local")
  })

  test("auto-detect follows the model's language unless preferLocal hints name another", () => {
    expect(onDeviceServes(listener("preferLocal"), "fr-FR", [])).toBe(true)
    expect(onDeviceServes(listener("preferLocal"), "en-US", ["en"])).toBe(true)
    expect(onDeviceServes(listener("preferLocal"), "en-US", ["en", "ja"])).toBe(false)
    expect(onDeviceServes(listener("localOnly"), "en-US", ["en", "ja"])).toBe(true)
    expect(targetSource(listener("preferLocal"), state({hints: ["en", "ja"]}))).toBe("cloud")
  })

  test("a specific language must be the model's", () => {
    expect(onDeviceServes(listener("preferLocal", "transcription:en-us"), "en-US", [])).toBe(true)
    expect(onDeviceServes(listener("preferLocal", "transcription:en-GB"), "en-US", [])).toBe(false)
  })
})

describe("switching source", () => {
  const never = () => false
  const always = () => true

  test("a new listener, or one already there, takes its target", () => {
    expect(handoffStep(null, "local", always, always, false)).toBe("settle")
    expect(handoffStep("local", "local", always, always, false)).toBe("settle")
  })

  test("a source that can no longer deliver is left right away", () => {
    expect(handoffStep("local", "cloud", (source) => source === "cloud", always, false)).toBe("forced")
  })

  test("a planned switch waits for both sources to settle, then for a drain", () => {
    expect(handoffStep("cloud", "local", always, (source) => source === "cloud", true)).toBe("wait")
    expect(handoffStep("cloud", "local", always, (source) => source === "local", true)).toBe("wait")
    expect(handoffStep("cloud", "local", always, never, false)).toBe("drain")
    expect(handoffStep("cloud", "local", always, never, true)).toBe("planned")
  })
})

describe("what runs", () => {
  test("a preferLocal listener on a running model needs no cloud stream", () => {
    const preferLocal = listener("preferLocal", "transcription:en-US")
    expect(needsCloud(preferLocal, "local", "local")).toBe(false)
    expect(needsLocal(preferLocal, "local", state())).toBe(true)
  })

  test("a listener keeps its old source until its switch completes", () => {
    expect(needsCloud(listener("preferLocal"), "cloud", "local")).toBe(true)
    expect(needsLocal(listener("preferCloud"), "local", state())).toBe(true)
  })

  test("preferLocal starts the picked model only when that model serves it", () => {
    expect(needsLocal(listener("preferLocal", "transcription:en-US"), null, state({localLanguage: null}))).toBe(true)
    expect(needsLocal(listener("preferLocal", "transcription:fr-FR"), "cloud", state())).toBe(false)
    expect(needsLocal(listener("preferLocal"), "cloud", state({onDevice: false}))).toBe(false)
    expect(needsCloud(listener("preferLocal", "transcription:fr-FR"), "cloud", "cloud")).toBe(true)
  })

  test("preferCloud always keeps its cloud stream and needs on-device only while the cloud is down", () => {
    expect(needsCloud(listener("preferCloud"), "local", "local")).toBe(true)
    expect(needsLocal(listener("preferCloud"), "cloud", state())).toBe(false)
    expect(needsLocal(listener("preferCloud"), "cloud", state({cloudConnected: false}))).toBe(true)
  })

  test("localOnly never needs the cloud", () => {
    expect(needsCloud(listener("localOnly"), "local", "local")).toBe(false)
    expect(needsLocal(listener("localOnly"), null, state())).toBe(true)
  })
})

describe("utterance tracking", () => {
  test("a source is busy in an utterance, and for a quiet window after its final", () => {
    const tracker = new UtteranceTracker()
    tracker.note("cloud", "transcription:en-US", false, 0)
    expect(tracker.busy("cloud", "transcription:en-US", 100)).toBe(true)
    expect(tracker.busy("cloud", "transcription:auto", 100)).toBe(true)
    expect(tracker.busy("cloud", "transcription:fr-FR", 100)).toBe(false)
    expect(tracker.busy("local", "transcription:en-US", 100)).toBe(false)
    tracker.note("cloud", "transcription:en-US", true, 200)
    // A late result for the same speech can still come from the other recognizer.
    expect(tracker.busy("cloud", "transcription:auto", 200 + SOURCE_QUIET_MS - 1)).toBe(true)
    expect(tracker.busy("cloud", "transcription:auto", 200 + SOURCE_QUIET_MS)).toBe(false)
  })

  test("an utterance whose final never comes ends after the stale window", () => {
    const tracker = new UtteranceTracker()
    tracker.note("local", "transcription:en-US", false, 0)
    expect(tracker.busy("local", "transcription:en-US", UTTERANCE_STALE_MS - 1)).toBe(true)
    expect(tracker.busy("local", "transcription:en-US", UTTERANCE_STALE_MS)).toBe(false)
  })

  test("a source that starts is busy on every stream for a quiet window; one that stops is not", () => {
    const tracker = new UtteranceTracker()
    tracker.started("local", 0)
    expect(tracker.busy("local", "transcription:fr-FR", SOURCE_QUIET_MS - 1)).toBe(true)
    expect(tracker.busy("local", "transcription:fr-FR", SOURCE_QUIET_MS)).toBe(false)
    tracker.note("local", "transcription:en-US", false, 0)
    tracker.clear("local")
    expect(tracker.busy("local", "transcription:en-US", 0)).toBe(false)
  })

  test("tells when the next busy stream settles", () => {
    const tracker = new UtteranceTracker()
    expect(tracker.nextSettle(0)).toBeNull()
    tracker.note("cloud", "transcription:en-US", false, 0)
    tracker.note("local", "transcription:en-US", true, 1000)
    expect(tracker.nextSettle(1000)).toBe(1000 + SOURCE_QUIET_MS)
    expect(tracker.nextSettle(1000 + SOURCE_QUIET_MS)).toBe(UTTERANCE_STALE_MS)
    expect(tracker.nextSettle(UTTERANCE_STALE_MS)).toBeNull()
  })
})
