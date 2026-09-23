/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {
  StreamPreviewError,
  type StreamPreviewHostPort,
  type StreamPreviewStartRequest,
  type StreamPreviewStatusEvent,
} from "../streamPreviewPort"

// The real preview handlers, extracted from the runtime source like the SoftAP suite does, so the
// identity plumbing under test is the one that ships without loading the Expo app singleton.
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["hasManifestPermission", "handleStreamPreviewStart", "handleStreamPreviewStop"]
  .map((name) => {
    const start = source.search(new RegExp(`^  (?:private|public) (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^  }$/m)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

function build(previewHost: StreamPreviewHostPort | null, permissions = [{type: "CAMERA"}]) {
  const Host = new Function(
    "getStreamPreviewHost",
    "StreamPreviewError",
    "MiniappResponseType",
    "LOG_TAG",
    "console",
    `${compiled}; return Host`,
  )(
    () => previewHost,
    StreamPreviewError,
    {STREAM_PREVIEW_STATUS: "miniapp_stream_preview_status"},
    "test",
    {warn: () => {}, log: () => {}},
  )
  const host = new Host()
  const results: Array<{ok: boolean; data?: unknown; error?: {code: string}}> = []
  const pushes: unknown[] = []
  host.connectedApps = new Map([["com.test.call", {runtimeId: "rt-1", installedManifest: {permissions}}]])
  host.sendResult = (_pkg: string, _id: string, ok: boolean, data?: unknown, error?: {code: string}) =>
    results.push({ok, data, error})
  host.sendToMiniapp = (_pkg: string, payload: unknown) => pushes.push(payload)
  return {host, results, pushes}
}

function fakePort() {
  const starts: StreamPreviewStartRequest[] = []
  const stops: unknown[] = []
  let notify: ((event: StreamPreviewStatusEvent) => void) | null = null
  const port: StreamPreviewHostPort = {
    async start(request, n) {
      starts.push(request)
      notify = n
      return {handleId: "h1", previewTraceId: "p1", source: "call"}
    },
    async stop(request) {
      stops.push(request)
    },
    releaseRuntime() {},
  }
  return {port, starts, stops, notify: (event: StreamPreviewStatusEvent) => notify?.(event)}
}

describe("LocalMiniappRuntime stream preview handlers", () => {
  test("start forwards identity and the CAMERA declaration, and replies with the lease", async () => {
    const fake = fakePort()
    const {host, results} = build(fake.port)
    await host.handleStreamPreviewStart("com.test.call", {source: "call"}, "r1")
    expect(fake.starts).toEqual([{packageName: "com.test.call", runtimeId: "rt-1", source: "call", hasCamera: true}])
    expect(results).toEqual([{ok: true, data: {handleId: "h1", previewTraceId: "p1", source: "call"}, error: undefined}])
  })

  test("a missing CAMERA declaration is passed on for the coordinator to refuse", async () => {
    const fake = fakePort()
    const {host} = build(fake.port, [])
    await host.handleStreamPreviewStart("com.test.call", {source: "call"}, "r1")
    expect(fake.starts[0]!.hasCamera).toBe(false)
  })

  test("typed refusals keep their code", async () => {
    const port: StreamPreviewHostPort = {
      start: async () => {
        throw new StreamPreviewError("not_meeting_owner", "Only the meeting owner may preview its call")
      },
      stop: async () => {},
      releaseRuntime: () => {},
    }
    const {host, results} = build(port)
    await host.handleStreamPreviewStart("com.test.call", {source: "call"}, "r1")
    expect(results[0]).toMatchObject({ok: false, error: {code: "not_meeting_owner"}})
  })

  test("a host without a coordinator answers unsupported", async () => {
    const {host, results} = build(null)
    await host.handleStreamPreviewStart("com.test.call", {source: "call"}, "r1")
    expect(results[0]).toMatchObject({ok: false, error: {code: "unsupported"}})
  })

  test("status pushes reach the runtime that took the lease, never its respawned successor", async () => {
    const fake = fakePort()
    const {host, pushes} = build(fake.port)
    await host.handleStreamPreviewStart("com.test.call", {source: "call"}, "r1")
    fake.notify({handleId: "h1", state: "held"})
    host.connectedApps.set("com.test.call", {runtimeId: "rt-2", installedManifest: {permissions: []}})
    fake.notify({handleId: "h1", state: "ended", reason: "runtime_replaced"})
    expect(pushes).toEqual([{type: "miniapp_stream_preview_status", handleId: "h1", state: "held"}])
  })

  test("stop carries the runtime identity and always succeeds from the miniapp's side", async () => {
    const fake = fakePort()
    const {host, results} = build(fake.port)
    await host.handleStreamPreviewStop("com.test.call", {handleId: "h1"}, "r2")
    await host.handleStreamPreviewStop("com.test.call", {}, "r3")
    expect(fake.stops).toEqual([{packageName: "com.test.call", runtimeId: "rt-1", handleId: "h1"}])
    expect(results.map((r) => r.ok)).toEqual([true, true])
  })
})
