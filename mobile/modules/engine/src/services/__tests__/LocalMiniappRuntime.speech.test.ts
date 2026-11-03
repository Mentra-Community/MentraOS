/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

import {readSpeechProcessing} from "../TranscriptionRouting"
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
// The cloud speech constants and failure classifier, as shipped.
const constantsStart = source.indexOf("const CLOUD_SPEECH_FORMAT")
const constants = source.slice(constantsStart, source.indexOf("const DIAGNOSTIC_MAX_LIST_ITEMS", constantsStart))
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`${constants}\nclass Host { ${methods} }`)

type Completion = (
  id: string,
  success: boolean,
  error: string | null,
  duration: number | null,
  reason: "completed" | "interrupted" | "error",
) => void
type PlayRequest = {requestId: string; audioUrl: string}
type PcmUrlRequest = {
  requestId: string
  appId: string
  url: string
  sampleRate: number
  volume: number
  jitterMs?: number
  stopOtherAudio: boolean
  suppressCloudUplink?: boolean
}

function createHost(options: {offlineAvailable?: boolean; cloudSpeak?: () => Promise<{audioUrl: string}>} = {}) {
  const {offlineAvailable = true} = options
  const plays: Array<{request: PlayRequest; complete: Completion}> = []
  const streams: Array<{request: PcmUrlRequest; complete: Completion}> = []
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
    playPcmUrl: mock(async (request: PcmUrlRequest, complete: Completion) => {
      streams.push({request, complete})
    }),
    cancelPlayback: mock((_id: string) => {}),
  }
  const ttsSpeak = mock(options.cloudSpeak ?? (async () => ({audioUrl: "https://runtime.test/api/tts/speak?x"})))
  const Host = new Function(
    "prepareTtsSentences",
    "readSpeechProcessing",
    "cloudClientService",
    "ttsModelManager",
    "audioPlaybackService",
    "isFeatureEnabled",
    "MiniappErrorCode",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    prepareTtsSentences,
    readSpeechProcessing,
    {isConnected: () => true, tts: {speak: ttsSpeak}},
    ttsModelManager,
    audioPlaybackService,
    () => true,
    {INTERNAL: "INTERNAL", TTS_UPSTREAM_ERROR: "TTS_UPSTREAM_ERROR", TTS_LOCAL_UNAVAILABLE: "TTS_LOCAL_UNAVAILABLE"},
    "TEST",
  )
  const host = new Host()
  host.speechRuns = new Map()
  host.setSpeakerState = mock(() => {})
  host.sendResult = mock(() => {})
  return {host, plays, streams, ttsModelManager, ttsSpeak, audioPlaybackService}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("cloud speech streams into the PCM player", () => {
  for (const appId of ["com.example.speech", "com.mentra.ai"]) {
    test(`every miniapp streams raw PCM with the shared startup buffer (${appId})`, async () => {
      const {host, streams, plays, ttsSpeak} = createHost()
      await host.handleSpeak(appId, {text: "A laptop and phone on a wooden desk.", volume: 0.6}, "speech")
      expect(ttsSpeak.mock.calls[0]?.[1]).toMatchObject({reusePreflight: true, format: "pcm_24000"})
      expect(plays).toHaveLength(0)
      expect(streams).toHaveLength(1)
      expect(streams[0].request).toEqual({
        requestId: "speech",
        appId,
        url: "https://runtime.test/api/tts/speak?x",
        sampleRate: 24000,
        volume: 0.6,
        jitterMs: 250,
        stopOtherAudio: true,
        suppressCloudUplink: false,
      })
      await settle()
      expect(host.setSpeakerState).toHaveBeenLastCalledWith(appId, "playing")
      streams[0].complete("speech", true, null, 2500, "completed")
      expect(host.sendResult).toHaveBeenCalledWith(appId, "speech", true, {completed: true, duration: 2500}, undefined)
      expect(host.setSpeakerState).toHaveBeenLastCalledWith(appId, "stopped", {durationMs: 2500})
    })
  }

  test("stopping speech aborts its stream and settles speak()", async () => {
    const {host, streams, audioPlaybackService} = createHost()
    await host.handleSpeak("com.example.speech", {text: "Old answer."}, "old")
    host.cancelSpeech("com.example.speech")
    expect(audioPlaybackService.cancelPlayback).toHaveBeenCalledWith("old")
    expect(host.sendResult).toHaveBeenCalledWith(
      "com.example.speech",
      "old",
      true,
      {completed: false, duration: null},
      undefined,
    )
    // The aborted stream's own completion can't send a second result.
    streams[0].complete("old", true, null, 300, "interrupted")
    expect(host.sendResult).toHaveBeenCalledTimes(1)
  })

  test("a connection lost mid-sentence ends speech with an error, not an offline restart", async () => {
    const {host, streams, ttsModelManager} = createHost()
    await host.handleSpeak("com.example.speech", {text: "A long answer."}, "speech")
    streams[0].complete("speech", false, "The network connection was lost.", 1800, "error")
    await settle()
    expect(ttsModelManager.synthesizeToFile).not.toHaveBeenCalled()
    expect(host.sendResult).toHaveBeenCalledWith(
      "com.example.speech",
      "speech",
      false,
      {completed: false, duration: 1800},
      {code: "TTS_UPSTREAM_ERROR", message: "The network connection was lost."},
    )
  })

  test("a refused synthesis played nothing, so offline speech says the answer", async () => {
    const {host, streams, plays, ttsModelManager} = createHost()
    await host.handleSpeak("com.example.speech", {text: "An answer."}, "speech")
    streams[0].complete("speech", false, "HTTP 401", 0, "error")
    await settle()
    expect(ttsModelManager.synthesizeToFile).toHaveBeenCalledWith("An answer.", expect.any(Object))
    expect(plays[0].request.audioUrl).toBe("file://offline.wav")
    plays[0].complete("speech", true, null, 900, "completed")
    expect(host.sendResult).toHaveBeenCalledWith(
      "com.example.speech",
      "speech",
      true,
      {completed: true, duration: 900},
      undefined,
    )
  })

  test("a failed preflight falls back to offline speech before any stream opens", async () => {
    const {host, streams, plays} = createHost({
      cloudSpeak: async () => {
        throw new Error("Runtime TTS does not support format pcm_24000")
      },
    })
    await host.handleSpeak("com.example.speech", {text: "An answer."}, "speech")
    expect(streams).toHaveLength(0)
    expect(plays[0].request.audioUrl).toBe("file://offline.wav")
  })

  test("native refusal codes and an output change before the first byte also fall back", async () => {
    for (const error of ["http_error: HTTP 429", "unsupported_format: audio/mpeg", "pcm stream speech is not open"]) {
      const {host, streams, plays} = createHost()
      await host.handleSpeak("com.example.speech", {text: "An answer."}, "speech")
      streams[0].complete("speech", false, error, 0, "error")
      await settle()
      expect(plays[0]?.request.audioUrl).toBe("file://offline.wav")
    }
    const {host, streams, plays} = createHost()
    await host.handleSpeak("com.example.speech", {text: "An answer."}, "speech")
    streams[0].complete("speech", false, "network_error: connection reset", 900, "error")
    await settle()
    expect(plays).toHaveLength(0)
  })

  test("without an offline model a refused synthesis reports the error", async () => {
    const {host, streams} = createHost({offlineAvailable: false})
    await host.handleSpeak("com.example.speech", {text: "An answer."}, "speech")
    streams[0].complete("speech", false, "HTTP 503", 0, "error")
    await settle()
    expect(host.sendResult).toHaveBeenCalledWith(
      "com.example.speech",
      "speech",
      false,
      {completed: false, duration: 0},
      {code: "TTS_UPSTREAM_ERROR", message: "HTTP 503"},
    )
  })

  test("a new wake word cancels recovery before the old answer can be synthesized", async () => {
    const {host, streams, ttsModelManager} = createHost()
    await host.handleSpeak("com.example.speech", {text: "Old answer."}, "old")
    host.cancelSpeech("com.example.speech")
    streams[0].complete("old", false, "HTTP 502", null, "error")
    await settle()
    expect(ttsModelManager.synthesizeToFile).not.toHaveBeenCalled()
    expect(host.sendResult).toHaveBeenCalledTimes(1)
  })
})

describe("processing", () => {
  test("localOnly speech never touches the cloud, as forceLocal from older SDKs", async () => {
    for (const payload of [{processing: "localOnly"}, {forceLocal: true}]) {
      const {host, streams, plays, ttsSpeak} = createHost()
      await host.handleSpeak("com.example.speech", {text: "Offline.", ...payload}, "local")
      expect(ttsSpeak).not.toHaveBeenCalled()
      expect(streams).toHaveLength(0)
      expect(plays[0].request.audioUrl).toBe("file://offline.wav")
    }
  })

  test("localOnly without the on-device model fails instead of using the cloud", async () => {
    const {host, ttsSpeak} = createHost({offlineAvailable: false})
    await host.handleSpeak("com.example.speech", {text: "Offline.", processing: "localOnly"}, "local")
    expect(ttsSpeak).not.toHaveBeenCalled()
    expect(host.sendResult).toHaveBeenCalledWith(
      "com.example.speech",
      "local",
      false,
      expect.anything(),
      expect.objectContaining({code: "TTS_LOCAL_UNAVAILABLE"}),
    )
  })

  test("preferLocal speaks on-device while the cloud is connected", async () => {
    const {host, streams, plays, ttsSpeak} = createHost()
    await host.handleSpeak("com.example.speech", {text: "Nearby.", processing: "preferLocal"}, "near")
    expect(ttsSpeak).not.toHaveBeenCalled()
    expect(streams).toHaveLength(0)
    expect(plays[0].request.audioUrl).toBe("file://offline.wav")
  })

  test("preferLocal uses cloud speech when the on-device model is missing or can't say it", async () => {
    for (const [options, payload] of [
      [{offlineAvailable: false}, {}],
      [{}, {voice_id: "cloud-only-voice"}],
    ] as const) {
      const {host, streams, plays, ttsSpeak} = createHost(options)
      await host.handleSpeak("com.example.speech", {text: "Far.", processing: "preferLocal", ...payload}, "far")
      expect(plays).toHaveLength(0)
      expect(ttsSpeak).toHaveBeenCalledTimes(1)
      expect(streams).toHaveLength(1)
    }
  })

  test("preferCloud, the default, speaks through the cloud while it is connected", async () => {
    const {host, streams, plays} = createHost()
    await host.handleSpeak("com.example.speech", {text: "Cloud.", processing: "preferCloud"}, "cloud")
    expect(streams).toHaveLength(1)
    expect(plays).toHaveLength(0)
  })
})
