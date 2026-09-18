/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"

import {ENGINE_ONLY_USE_CASES, MIC_USE_CASES, VOICE_CALL_PACKAGES} from "../micPolicy"

/**
 * Who may ask the host for which microphone.
 *
 * Same technique as LocalMiniappRuntime.softap.test.ts: run the real private handlers rather than
 * a retyped copy, so a change to the gate cannot leave this suite green.
 */
const source = readFileSync(new URL("../LocalMiniappRuntime.ts", import.meta.url), "utf8")
const methods = ["handleMicAcquire", "handleMicRelease", "forgetMicSessions"]
  .map((name) => {
    const start = source.search(new RegExp(`^  private (?:async )?${name}\\(`, "m"))
    if (start < 0) throw new Error(`Missing runtime method ${name}`)
    const rest = source.slice(start)
    const end = rest.search(/^  }$/m)
    if (end < 0) throw new Error(`Missing end of runtime method ${name}`)
    return rest.slice(0, end + 3)
  })
  .join("\n")
const compiled = new Bun.Transpiler({loader: "ts"}).transformSync(`class Host { ${methods} }`)

const MiniappErrorCode = {
  PERMISSION_NOT_DECLARED: "PERMISSION_NOT_DECLARED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  MIC_SOURCE_CONFLICT: "MIC_SOURCE_CONFLICT",
  INTERNAL: "INTERNAL",
}
const MiniappRequestType = {MIC_ACQUIRE: "miniapp_mic_acquire"}
const MIC_SOURCE_CONFLICT = "MIC_SOURCE_CONFLICT"

type Result = {ok: boolean; data?: unknown; error?: {code: string; message: string}}

function createHost(options: {micPermission?: boolean; acquireThrows?: Error} = {}) {
  const results: Result[] = []
  const released: number[] = []
  let nextId = 1

  const micSessionManager = {
    acquire: (args: {owner: string; source: string; useCase: string}) => {
      if (options.acquireThrows) throw options.acquireThrows
      const id = nextId++
      return {id, ...args, release: () => released.push(id)}
    },
  }

  const Host = new Function(
    "MiniappErrorCode",
    "MiniappRequestType",
    "micSessionManager",
    "MIC_SOURCE_CONFLICT",
    "MIC_USE_CASES",
    "VOICE_CALL_PACKAGES",
    "ENGINE_ONLY_USE_CASES",
    "logPermissionNotDeclared",
    "LOG_TAG",
    `${compiled}; return Host`,
  )(
    MiniappErrorCode,
    MiniappRequestType,
    micSessionManager,
    MIC_SOURCE_CONFLICT,
    MIC_USE_CASES,
    VOICE_CALL_PACKAGES,
    ENGINE_ONLY_USE_CASES,
    () => {},
    "TEST",
  )

  const host = new Host()
  host.micSessionsByApp = new Map()
  host.connectedApps = new Map([
    [
      "com.mentra.call",
      {installedManifest: {permissions: options.micPermission === false ? [] : [{type: "MICROPHONE"}]}},
    ],
    ["com.other.app", {installedManifest: {permissions: [{type: "MICROPHONE"}]}}],
    ["com.nomic.app", {installedManifest: {permissions: []}}],
  ])
  host.sendResult = (_pkg: string, _id: unknown, ok: boolean, data?: unknown, error?: Result["error"]) => {
    results.push({ok, data, error})
  }
  return {host, results, released}
}

describe("mic session host gate", () => {
  let harness: ReturnType<typeof createHost>
  beforeEach(() => {
    harness = createHost()
  })

  test("Mentra Call may take a voice-call microphone", () => {
    harness.host.handleMicAcquire("com.mentra.call", {source: "glasses", useCase: "voice_call"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({ok: true, data: {sessionId: 1}})
  })

  test("any other miniapp is refused a voice-call microphone", () => {
    // The profile behind `voice_call` is tuned for close-talk speech, so which app gets it is a
    // product decision rather than something a manifest can grant itself.
    expect(VOICE_CALL_PACKAGES).toEqual(["com.mentra.call"])
    harness.host.handleMicAcquire("com.other.app", {source: "glasses", useCase: "voice_call"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({
      ok: false,
      error: {code: "PERMISSION_DENIED"},
    })
  })

  test("a diagnostic lease is reserved for the Mentra App", () => {
    // Otherwise a dev miniapp could pair a glasses diagnostic lease with a meeting join.
    expect(ENGINE_ONLY_USE_CASES).toContain("diagnostic")
    harness.host.handleMicAcquire("com.other.app", {source: "glasses", useCase: "diagnostic"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({ok: false, error: {code: "PERMISSION_DENIED"}})
  })

  test("a transcription lease needs no allowlist", () => {
    harness.host.handleMicAcquire("com.other.app", {source: "glasses", useCase: "transcription"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({ok: true})
  })

  test("MICROPHONE has to be declared", () => {
    harness.host.handleMicAcquire("com.nomic.app", {source: "glasses", useCase: "transcription"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({
      ok: false,
      error: {code: "PERMISSION_NOT_DECLARED"},
    })
  })

  test("an unknown source or use case is rejected before it reaches the manager", () => {
    harness.host.handleMicAcquire("com.other.app", {source: "telepathy", useCase: "transcription"}, "r1")
    expect(harness.results.at(-1)).toMatchObject({ok: false, error: {code: "INVALID_ARGUMENT"}})
    harness.host.handleMicAcquire("com.other.app", {source: "glasses", useCase: "karaoke"}, "r2")
    expect(harness.results.at(-1)).toMatchObject({ok: false, error: {code: "INVALID_ARGUMENT"}})
  })

  test("a source conflict is reported as itself, not as an internal error", () => {
    const conflicted = createHost({acquireThrows: new Error(`${MIC_SOURCE_CONFLICT}: already on glasses`)})
    conflicted.host.handleMicAcquire("com.other.app", {source: "phone", useCase: "transcription"}, "r1")
    expect(conflicted.results.at(-1)).toMatchObject({ok: false, error: {code: "MIC_SOURCE_CONFLICT"}})
  })

  test("release hands back a session the caller owns", () => {
    harness.host.handleMicAcquire("com.mentra.call", {source: "glasses", useCase: "voice_call"}, "r1")
    harness.host.handleMicRelease("com.mentra.call", {sessionId: 1}, "r2")
    expect(harness.released).toEqual([1])
    expect(harness.results.at(-1)).toMatchObject({ok: true})
  })

  test("one miniapp cannot release another's session", () => {
    harness.host.handleMicAcquire("com.mentra.call", {source: "glasses", useCase: "voice_call"}, "r1")
    harness.host.handleMicRelease("com.other.app", {sessionId: 1}, "r2")
    expect(harness.released).toEqual([])
  })

  test("releasing twice is not an error a teardown path can trip over", () => {
    harness.host.handleMicAcquire("com.mentra.call", {source: "glasses", useCase: "voice_call"}, "r1")
    harness.host.handleMicRelease("com.mentra.call", {sessionId: 1}, "r2")
    harness.host.handleMicRelease("com.mentra.call", {sessionId: 1}, "r3")
    expect(harness.released).toEqual([1])
    expect(harness.results.at(-1)).toMatchObject({ok: true})
  })

  test("unregister forgets the bookkeeping for an app's sessions", () => {
    harness.host.handleMicAcquire("com.mentra.call", {source: "glasses", useCase: "voice_call"}, "r1")
    harness.host.forgetMicSessions("com.mentra.call")
    expect(harness.host.micSessionsByApp.size).toBe(0)
  })
})

describe("meeting join gate", () => {
  /**
   * Read from the source rather than retyped: the whole point is that Mentra Call cannot start a
   * call without a microphone session, while other joiners keep working without one.
   */
  const handler = source.slice(source.search(/^  private async handleMeetingJoin\(/m))

  test("an allowlisted package without a session is refused", () => {
    expect(handler).toContain("micSessionManager.hasGlassesSession(packageName)")
    expect(handler).toContain("VOICE_CALL_PACKAGES.includes(packageName) && !glassesSession")
    expect(handler).toContain("MiniappErrorCode.MIC_SESSION_REQUIRED")
  })

  test("the gate runs before either join path", () => {
    const gate = handler.indexOf("MIC_SESSION_REQUIRED")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(handler.indexOf("joinSoftapMeeting"))
    expect(gate).toBeLessThan(handler.indexOf("acsMeetingService.join"))
  })

  test("both join paths are told whether a session exists", () => {
    // Without this the SoftAP orchestrator would pick the BLE LC3 uplink for a call whose
    // microphone nobody has leased.
    expect(handler).toContain("glassesSession,")
  })
})
