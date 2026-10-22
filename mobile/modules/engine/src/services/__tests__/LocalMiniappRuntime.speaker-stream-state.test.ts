/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"
import {readFileSync} from "node:fs"

const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleSpeakerStreamOpen", "setSpeakerState"]
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
  const outbound: Array<{packageName: string; payload: Record<string, unknown>}> = []
  const audioPlaybackService = {
    openStream: mock(async (request: Record<string, unknown>) => {
      opens.push(request)
    }),
    abortStream: mock(async (_streamId: string) => {}),
  }
  const Host = new Function(
    "MiniappErrorCode",
    "MiniappResponseType",
    "LocalMiniappRuntime",
    "audioPlaybackService",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    {INVALID_ARGUMENT: "INVALID_ARGUMENT", INTERNAL: "INTERNAL"},
    {SPEAKER_STATE: "miniapp_speaker_state"},
    {SPEAKER_STREAM_SAMPLE_RATES: new Set([16000, 24000, 48000])},
    audioPlaybackService,
    "TEST",
  )

  const host = new Host()
  host.connectedApps = new Map([[appId, app]])
  host.speakerStreamCounter = 0
  host.sendResult = mock(() => {})
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
})
