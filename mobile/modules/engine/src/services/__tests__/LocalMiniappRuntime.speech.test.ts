/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

import {prepareTtsSentences} from "../TtsTextSanitizer"

// Exercise the real handlers without booting the engine's native dependencies,
// following LocalMiniappRuntime.mic.test.ts.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleSpeak", "cancelSpeech"]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^ {2}\}$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

type PlayRequest = {requestId: string; audioUrl: string}
type Completion = (
  id: string,
  success: boolean,
  error: string | null,
  duration: number | null,
  reason: "completed" | "interrupted" | "error",
) => void

function createHost(offlineAvailable = true) {
  const plays: Array<{request: PlayRequest; complete: Completion}> = []
  const cleanup = mock(async () => {})
  const ttsModelManager = {
    isModelAvailable: mock(async () => offlineAvailable),
    getAvailableLanguages: () => [{code: "en"}],
    synthesizeToFile: mock(async () => ({audioUrl: "file://offline.wav", cleanup})),
  }
  const audioPlaybackService = {
    play: mock(async (request: PlayRequest, complete: Completion) => {
      plays.push({request, complete})
    }),
    cancelPlayback: mock(() => {}),
  }
  const Host = new Function(
    "prepareTtsSentences",
    "cloudClientService",
    "ttsModelManager",
    "audioPlaybackService",
    "isFeatureEnabled",
    "MiniappErrorCode",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    prepareTtsSentences,
    {isConnected: () => true, tts: {speak: async () => ({audioUrl: "https://example.test/tts"})}},
    ttsModelManager,
    audioPlaybackService,
    () => true,
    {INTERNAL: "INTERNAL", TTS_UPSTREAM_ERROR: "TTS_UPSTREAM_ERROR"},
    "TEST",
  )
  const host = new Host()
  host.speechRuns = new Map()
  host.setSpeakerState = mock(() => {})
  host.sendResult = mock(() => {})
  return {host, plays, ttsModelManager, cleanup}
}

const appId = "com.mentra.ai"

async function flushFallback() {
  // The callback schedules model availability, synthesis, playback and state updates.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("cloud speech native failure recovery", () => {
  test("plays the same answer offline after an explicit native playback error", async () => {
    const {host, plays, ttsModelManager, cleanup} = createHost()
    await host.handleSpeak(appId, {text: "An answer."}, "speech")
    expect(plays[0].request).toMatchObject({audioUrl: "https://example.test/tts"})

    plays[0].complete("speech", false, "Playback failed (native player failed)", null, "error")
    await flushFallback()
    expect(ttsModelManager.synthesizeToFile).toHaveBeenCalledWith("An answer.", expect.any(Object))
    expect(plays[1].request).toMatchObject({audioUrl: "file://offline.wav"})
    expect(host.sendResult).not.toHaveBeenCalled()

    plays[1].complete("speech", true, null, 1200, "completed")
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(host.sendResult).toHaveBeenCalledWith(appId, "speech", true, {completed: true, duration: 1200}, undefined)
    expect(host.setSpeakerState).toHaveBeenLastCalledWith(appId, "stopped", {durationMs: 1200})
  })

  test("returns an explicit error when the offline model is unavailable", async () => {
    const {host, plays} = createHost(false)
    await host.handleSpeak(appId, {text: "An answer."}, "speech")
    plays[0].complete("speech", false, "Playback failed (native player failed)", null, "error")
    await flushFallback()
    expect(plays).toHaveLength(1)
    expect(host.sendResult).toHaveBeenCalledWith(
      appId,
      "speech",
      false,
      {completed: false, duration: null},
      {code: "TTS_UPSTREAM_ERROR", message: "Playback failed (native player failed)"},
    )
  })

  test("a new wake word cancels recovery before the old answer can be synthesized", async () => {
    const {host, plays, ttsModelManager} = createHost()
    await host.handleSpeak(appId, {text: "Old answer."}, "old")
    plays[0].complete("old", false, "Playback failed (native player failed)", null, "error")
    // Cancel while the fallback is awaiting model availability.
    host.cancelSpeech(appId)
    await flushFallback()
    expect(ttsModelManager.synthesizeToFile).not.toHaveBeenCalled()
    expect(plays).toHaveLength(1)
    expect(host.sendResult).toHaveBeenCalledTimes(1)
    expect(host.sendResult).toHaveBeenCalledWith(appId, "old", true, {completed: false, duration: null}, undefined)
  })
})
