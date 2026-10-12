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

type PlayRequest = {requestId: string; audioUrl: string; startupTimeoutMs?: number}
type Completion = (
  id: string,
  success: boolean,
  error: string | null,
  duration: number | null,
  reason: "completed" | "interrupted" | "error",
) => void

type DownloadedAudio = {audioUrl: string; cleanup: () => Promise<void>}

function createHost(
  offlineAvailable = true,
  download: (url: string, timeoutMs: number, cleanup: () => Promise<void>) => Promise<DownloadedAudio> = async (
    _url,
    _timeoutMs,
    cleanup,
  ) => ({audioUrl: "file://cloud.mp3", cleanup}),
) {
  const plays: Array<{request: PlayRequest; complete: Completion}> = []
  const cleanup = mock(async () => {})
  const cloudCleanup = mock(async () => {})
  const downloadCloudTtsAudio = mock((url: string, timeoutMs: number) => download(url, timeoutMs, cloudCleanup))
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
    "downloadCloudTtsAudio",
    "cloudTtsDownloadTimeoutMs",
    "isFeatureEnabled",
    "MiniappErrorCode",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    prepareTtsSentences,
    {isConnected: () => true, tts: {speak: async () => ({audioUrl: "https://example.test/tts"})}},
    ttsModelManager,
    audioPlaybackService,
    downloadCloudTtsAudio,
    (text: string) => 5000 + text.length * 3,
    () => true,
    {INTERNAL: "INTERNAL", TTS_UPSTREAM_ERROR: "TTS_UPSTREAM_ERROR"},
    "TEST",
  )
  const host = new Host()
  host.speechRuns = new Map()
  host.setSpeakerState = mock(() => {})
  host.sendResult = mock(() => {})
  return {host, plays, ttsModelManager, cleanup, cloudCleanup, downloadCloudTtsAudio}
}

const appId = "com.mentra.ai"

async function flushFallback() {
  // The callback schedules model availability, synthesis, playback and state updates.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("cloud speech download", () => {
  test("plays downloaded cloud speech from a local file, never the streaming URL", async () => {
    const {host, plays, cloudCleanup, downloadCloudTtsAudio, ttsModelManager} = createHost()
    const answer = "A laptop and phone on a wooden desk."
    await host.handleSpeak(appId, {text: answer}, "speech")

    expect(downloadCloudTtsAudio).toHaveBeenCalledWith("https://example.test/tts", 5000 + answer.length * 3)
    expect(plays).toHaveLength(1)
    expect(plays[0].request).toMatchObject({audioUrl: "file://cloud.mp3", startupTimeoutMs: 5000})
    expect(cloudCleanup).not.toHaveBeenCalled()

    plays[0].complete("speech", true, null, 2500, "completed")
    expect(cloudCleanup).toHaveBeenCalledTimes(1)
    expect(ttsModelManager.synthesizeToFile).not.toHaveBeenCalled()
    expect(host.sendResult).toHaveBeenCalledWith(appId, "speech", true, {completed: true, duration: 2500}, undefined)
  })

  test("a cloud download that misses its deadline speaks the same answer offline", async () => {
    const {host, plays, ttsModelManager} = createHost(true, async () => {
      throw new Error("Cloud TTS download did not finish within 5030ms")
    })
    await host.handleSpeak(appId, {text: "An answer."}, "speech")

    expect(ttsModelManager.synthesizeToFile).toHaveBeenCalledWith("An answer.", expect.any(Object))
    expect(plays).toHaveLength(1)
    expect(plays[0].request).toMatchObject({audioUrl: "file://offline.wav"})
    plays[0].complete("speech", true, null, 900, "completed")
    expect(host.sendResult).toHaveBeenCalledWith(appId, "speech", true, {completed: true, duration: 900}, undefined)
  })

  test("a run cancelled mid-download discards the file without playing it", async () => {
    let finish!: () => void
    const {host, plays, cloudCleanup} = createHost(
      true,
      (_url, _timeoutMs, cleanup) =>
        new Promise((resolve) => {
          finish = () => resolve({audioUrl: "file://cloud.mp3", cleanup})
        }),
    )
    const speaking = host.handleSpeak(appId, {text: "Old answer."}, "old")
    await flushFallback()
    host.cancelSpeech(appId)
    finish()
    await speaking

    expect(plays).toHaveLength(0)
    expect(cloudCleanup).toHaveBeenCalledTimes(1)
    expect(host.sendResult).toHaveBeenCalledWith(appId, "old", true, {completed: false, duration: null}, undefined)
  })

  test("a failed cloud file deletes its download before the offline retry", async () => {
    const {host, plays, cloudCleanup} = createHost()
    await host.handleSpeak(appId, {text: "An answer."}, "speech")
    plays[0].complete("speech", false, "Playback did not start within 5000ms", null, "error")
    expect(cloudCleanup).toHaveBeenCalledTimes(1)
  })
})

describe("cloud speech native failure recovery", () => {
  test("a cloud startup timeout speaks the error response offline", async () => {
    const {host, plays, ttsModelManager} = createHost()
    const response = "I'm sorry, I couldn't process that. Please try again."
    await host.handleSpeak(appId, {text: response}, "error-speech")
    expect(plays[0].request.startupTimeoutMs).toBe(5000)
    plays[0].complete("error-speech", false, "Playback did not start within 5000ms", null, "error")
    await flushFallback()
    expect(ttsModelManager.synthesizeToFile).toHaveBeenCalledWith(response, expect.any(Object))
    expect(plays[1].request).toMatchObject({audioUrl: "file://offline.wav"})
    expect(plays[1].request.startupTimeoutMs).toBeUndefined()
    plays[1].complete("error-speech", true, null, 3000, "completed")
    expect(host.sendResult).toHaveBeenCalledTimes(1)
    expect(host.sendResult).toHaveBeenCalledWith(
      appId,
      "error-speech",
      true,
      {completed: true, duration: 3000},
      undefined,
    )
  })

  test("plays the same answer offline after an explicit native playback error", async () => {
    const {host, plays, ttsModelManager, cleanup} = createHost()
    await host.handleSpeak(appId, {text: "An answer."}, "speech")
    expect(plays[0].request).toMatchObject({audioUrl: "file://cloud.mp3"})

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
