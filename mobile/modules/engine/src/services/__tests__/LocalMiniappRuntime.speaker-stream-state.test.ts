/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handlePlayAudio", "handleSpeak", "handleSpeakerStreamOpen", "setSpeakerState", "stopActiveSpeakerStream"]
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

const appId = "com.mentra.voice"

function createHost(app: {speakerState: string; activeSpeakerStreamId?: string}) {
  const opens: Array<Record<string, unknown>> = []
  const streamEndCallbacks = new Map<string, (id: string, success: boolean, error: string | null, durationMs: number) => void>()
  const outbound: Array<{packageName: string; payload: Record<string, unknown>}> = []
  const audioPlaybackService = {
    openStream: mock(async (request: Record<string, unknown>) => {
      opens.push(request)
      streamEndCallbacks.set(
        request.streamId as string,
        request.onEnded as (id: string, success: boolean, error: string | null, durationMs: number) => void,
      )
    }),
    abortStream: mock(async (streamId: string) => {
      streamEndCallbacks.get(streamId)?.(streamId, true, null, 12)
      streamEndCallbacks.delete(streamId)
    }),
    play: mock((request: Record<string, unknown>) => {
      if (request.stopOtherAudio) {
        // Model the audio service aborting streams after its async setup.
        queueMicrotask(() => queueMicrotask(() => {
          for (const streamId of streamEndCallbacks.keys()) {
            void audioPlaybackService.abortStream(streamId)
          }
        }))
      }
    }),
  }
  const Host = new Function(
    "MiniappErrorCode",
    "MiniappResponseType",
    "LocalMiniappRuntime",
    "audioPlaybackService",
    "LOG_TAG",
    "prepareTtsSentences",
    "ttsModelManager",
    "cloudClientService",
    "isFeatureEnabled",
    "runSentenceTtsPipeline",
    "downloadCloudTtsAudio",
    "cloudTtsDownloadTimeoutMs",
    `${compiled}; return Host`,
  )(
    {
      INVALID_ARGUMENT: "INVALID_ARGUMENT",
      INTERNAL: "INTERNAL",
      TTS_UPSTREAM_ERROR: "TTS_UPSTREAM_ERROR",
      TTS_LOCAL_UNAVAILABLE: "TTS_LOCAL_UNAVAILABLE",
    },
    {SPEAKER_STATE: "miniapp_speaker_state"},
    {SPEAKER_STREAM_SAMPLE_RATES: new Set([16000, 24000, 48000])},
    audioPlaybackService,
    "TEST",
    (sentences: string[]) => sentences,
    {
      getAvailableLanguages: () => [],
      isModelAvailable: async () => true,
      synthesizeToFile: async () => ({audioUrl: "file://hello.wav", cleanup: () => {}}),
    },
    {isConnected: () => false},
    () => true,
    () => Promise.resolve({success: true}),
    () => Promise.resolve({audioUrl: "file://unused.wav"}),
    () => 1000,
  )

  const host = new Host()
  host.connectedApps = new Map([[appId, app]])
  host.speakerStreamCounter = 0
  host.speechRuns = new Map()
  host.sendResult = mock(() => {})
  host.cancelSpeech = mock(() => {})
  host.sendToMiniapp = mock((packageName: string, payload: Record<string, unknown>) => {
    outbound.push({packageName, payload})
  })
  return {host, opens, outbound, audioPlaybackService}
}

describe("LocalMiniappRuntime speaker stream state events", () => {
  test("tags stream completion so the SDK can reconcile the matching writer", async () => {
    const {host, opens, outbound} = createHost({speakerState: "idle"})

    await host.handleSpeakerStreamOpen(appId, {sampleRate: 24000}, "open-1")
    const opened = opens[0]!
    const streamId = opened.streamId as string

    expect(outbound.map(({payload}) => payload.state)).toEqual(["loading", "playing"])
    ;(opened.onEnded as (id: string, success: boolean, error: string | null, durationMs: number) => void)(
      streamId,
      true,
      null,
      321,
    )

    expect(outbound.at(-1)).toEqual({
      packageName: appId,
      payload: {
        type: "miniapp_speaker_state",
        state: "stopped",
        durationMs: 321,
        streamId,
      },
    })
  })

  test("settles a failed stream from its scoped error event to stopped", async () => {
    const {host, opens, outbound} = createHost({speakerState: "idle"})

    await host.handleSpeakerStreamOpen(appId, {sampleRate: 24000}, "open-error")
    const opened = opens[0]!
    const streamId = opened.streamId as string
    ;(opened.onEnded as (id: string, success: boolean, error: string | null, durationMs: number) => void)(
      streamId,
      false,
      "decode failed",
      12,
    )

    expect(outbound.slice(-2)).toEqual([
      {
        packageName: appId,
        payload: {
          type: "miniapp_speaker_state",
          state: "error",
          streamId,
          errorCode: "INTERNAL",
          errorMessage: "decode failed",
          durationMs: 12,
        },
      },
      {
        packageName: appId,
        payload: {type: "miniapp_speaker_state", state: "stopped"},
      },
    ])
  })

  test("reports the replaced stream as ended before opening its replacement", async () => {
    const {host, opens, outbound} = createHost({speakerState: "playing", activeSpeakerStreamId: "old-stream"})

    await host.handleSpeakerStreamOpen(appId, {sampleRate: 16000}, "open-2")

    expect(outbound[0]).toEqual({
      packageName: appId,
      payload: {type: "miniapp_speaker_state", state: "stopped", streamId: "old-stream"},
    })
    expect(outbound.map(({payload}) => payload.state)).toEqual(["stopped", "loading", "playing"])
    expect(opens).toHaveLength(1)
  })

  test("ends the stream before reporting replacement URL playback as loading and playing", async () => {
    const {host, opens, outbound} = createHost({speakerState: "idle"})

    await host.handleSpeakerStreamOpen(appId, {sampleRate: 24000}, "open-before-play")
    const streamId = opens[0]!.streamId as string
    const start = outbound.length

    await host.handlePlayAudio(appId, {audioUrl: "file://answer.wav", stopOtherAudio: true}, "play-after-stream")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(outbound.slice(start).map(({payload}) => [payload.state, payload.streamId])).toEqual([
      ["stopped", streamId],
      ["loading", undefined],
      ["playing", undefined],
    ])
  })

  test("ends the stream before reporting replacement speech as loading and playing", async () => {
    const {host, opens, outbound} = createHost({speakerState: "idle"})

    await host.handleSpeakerStreamOpen(appId, {sampleRate: 24000}, "open-before-speak")
    const streamId = opens[0]!.streamId as string
    const start = outbound.length

    await host.handleSpeak(appId, {text: "Hello", forceLocal: true, stopOtherAudio: true}, "speak-after-stream")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(outbound.slice(start).map(({payload}) => [payload.state, payload.streamId])).toEqual([
      ["stopped", streamId],
      ["loading", undefined],
      ["playing", undefined],
    ])
  })
})
