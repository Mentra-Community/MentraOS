/// <reference types="bun-types" />
// eslint-disable-next-line import/no-unresolved
import {beforeEach, describe, expect, test} from "bun:test"

import type {MentraUIHostReply, StreamPreviewStatusEvent} from "@mentra/engine-host-internal"

import {createPreviewTraceLogger} from "./previewTrace"
import {
  StreamPreviewCoordinator,
  type StreamPreviewDocumentConfig,
  type StreamPreviewNative,
} from "./StreamPreviewCoordinator"

const PKG = "com.test.call"
const OTHER = "com.test.other"
const TOKEN = "SECRET-TOKEN-7d1f"
const URL_WITH_TOKEN = "ws://127.0.0.1:41234/preview?token=SECRET-TOKEN-7d1f"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {promise, resolve, reject}
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeNative implements StreamPreviewNative {
  calls: string[] = []
  protocolVersion = 1
  transport: "webmessage" | "websocket" = "websocket"
  bindResult: {installReloadRequired: boolean; unavailableReason?: string} = {installReloadRequired: false}
  holdStop: ReturnType<typeof deferred> | null = null
  failStart: Error | null = null
  throwStopSync = false
  prepareError: {code: string} | null = null
  rejectFault: {code: string} | null = null
  faults: Array<{kind: string; ms?: number}> = []
  diagnosticsEnabled = false
  prepared = 0
  private listeners = new Map<string, (event: never) => void>()

  async bind(options: {hostViewTag: number; packageName: string}) {
    this.calls.push(`bind:${options.packageName}`)
    return this.bindResult
  }
  async prepareDocument(options: {docGen: number}): Promise<StreamPreviewDocumentConfig> {
    this.prepared += 1
    this.calls.push(`prepare:${options.docGen}`)
    if (this.prepareError) throw Object.assign(new Error(this.prepareError.code), this.prepareError)
    return {
      protocolVersion: this.protocolVersion,
      transport: this.transport,
      url: URL_WITH_TOKEN,
      token: TOKEN,
      docGen: options.docGen,
    }
  }
  async configure(options: {targetWidth: number; targetHeight: number; maxFps: number}) {
    this.calls.push(`configure:${options.targetWidth}x${options.targetHeight}@${options.maxFps}`)
  }
  async start() {
    this.calls.push("start")
    if (this.failStart) throw this.failStart
  }
  stop(reason: string): Promise<void> {
    this.calls.push(`stop:${reason}`)
    if (this.throwStopSync) throw new Error("native stop exploded")
    return this.holdStop?.promise ?? Promise.resolve()
  }
  async unbind(reason: string) {
    this.calls.push(`unbind:${reason}`)
  }
  async injectFault(options: {kind: string; ms?: number}) {
    if (this.rejectFault) throw Object.assign(new Error(this.rejectFault.code), this.rejectFault)
    this.faults.push(options)
  }
  async setDiagnosticsEnabled(enabled: boolean) {
    this.diagnosticsEnabled = enabled
  }
  addListener(event: string, listener: (event: never) => void) {
    this.listeners.set(event, listener)
    return {remove: () => this.listeners.delete(event)}
  }
  emit(event: "onStatus" | "onStopped" | "onLog", payload: unknown) {
    this.listeners.get(event)?.(payload as never)
  }
  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length
  }
}

/** The read-only meeting view. Anything but these two members counts as touching the call. */
class FakeMeetings {
  meeting: {ownerPackage: string; instanceId: string} | null = null
  touched: string[] = []
  listenerErrors: unknown[] = []
  private seq = 0
  private listeners = new Set<(id: string) => void>()
  current() {
    this.touched.push("current")
    return this.meeting
  }
  onReleased(listener: (id: string) => void) {
    this.touched.push("onReleased")
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  join(owner: string) {
    this.seq += 1
    this.meeting = {ownerPackage: owner, instanceId: `m${this.seq}`}
  }
  end() {
    const meeting = this.meeting
    this.meeting = null
    if (!meeting) return
    for (const listener of this.listeners) {
      try {
        listener(meeting.instanceId)
      } catch (error) {
        this.listenerErrors.push(error)
      }
    }
  }
}

class FakeUi {
  replies = new Map<string, MentraUIHostReply>()
  pushes: Array<{packageName: string; payload: Record<string, unknown>}> = []
  reply(_packageName: string, requestId: string, reply: MentraUIHostReply) {
    this.replies.set(requestId, reply)
  }
  push(packageName: string, payload: Record<string, unknown>) {
    this.pushes.push({packageName, payload})
  }
  events(): string[] {
    return this.pushes.map(
      (p) =>
        String(p.payload.t) +
        (p.payload.reason ? `:${p.payload.reason}` : "") +
        (p.payload.code ? `:${p.payload.code}` : ""),
    )
  }
}

let native: FakeNative
let meetings: FakeMeetings
let ui: FakeUi
let lines: string[]
let levels: Array<"log" | "warn">
let diagnostics: boolean
let clock: number
let ids: number
let coordinator: StreamPreviewCoordinator
let notified: StreamPreviewStatusEvent[]
let requestSeq: number

beforeEach(() => {
  native = new FakeNative()
  meetings = new FakeMeetings()
  ui = new FakeUi()
  lines = []
  levels = []
  diagnostics = false
  clock = 1000
  ids = 0
  notified = []
  requestSeq = 0
  coordinator = new StreamPreviewCoordinator({
    native,
    meetings,
    ui,
    now: () => clock,
    newId: () => `id${++ids}`,
    log: createPreviewTraceLogger({
      now: () => clock,
      sink: (level, line) => {
        lines.push(line)
        levels.push(level)
      },
    }),
    diagnosticsAllowed: () => diagnostics,
  })
})

function startLease(packageName = PKG, runtimeId = "rt-1", extra: {hasCamera?: boolean; source?: unknown} = {}) {
  return coordinator.start(
    {packageName, runtimeId, source: extra.source ?? "call", hasCamera: extra.hasCamera ?? true},
    (event) => notified.push(event),
  )
}

async function page(payload: Record<string, unknown>, packageName = PKG): Promise<MentraUIHostReply> {
  const requestId = `r${++requestSeq}`
  coordinator.handleUiRequest(packageName, requestId, payload)
  await flush()
  const reply = ui.replies.get(requestId)
  if (!reply) throw new Error(`no reply for ${JSON.stringify(payload)}`)
  return reply
}

function result(reply: MentraUIHostReply): Record<string, unknown> {
  expect(reply.ok).toBe(true)
  return (reply as {result: Record<string, unknown>}).result
}

/** A mounted, visible preview: lease held, view bound, document handshaken, production running. */
async function running(mountEpoch = 1) {
  meetings.join(PKG)
  const lease = await startLease()
  await coordinator.bindView({packageName: PKG, hostViewTag: 42})
  coordinator.documentReady(PKG)
  const config = result(await page({cmd: "handshake", docGen: 0, mountEpoch}))
  const identity = {docGen: config.docGen as number, token: config.token as string}
  result(await page({cmd: "configure", ...identity, mountEpoch, boxWidth: 300, boxHeight: 169}))
  result(await page({cmd: "start", ...identity, mountEpoch}))
  await flush()
  return {lease, identity}
}

describe("authorization", () => {
  const cases: Array<{
    name: string
    setup: () => void
    request: {packageName?: string; hasCamera?: boolean; source?: unknown}
    code: string
  }> = [
    {name: "non-owner with CAMERA", setup: () => meetings.join(OTHER), request: {}, code: "not_meeting_owner"},
    {
      name: "owner without CAMERA",
      setup: () => meetings.join(PKG),
      request: {hasCamera: false},
      code: "permission_denied",
    },
    {name: "no active meeting", setup: () => {}, request: {}, code: "not_meeting_owner"},
    {name: "the glasses source", setup: () => meetings.join(PKG), request: {source: "glasses"}, code: "unsupported"},
    {name: "an unknown source", setup: () => meetings.join(PKG), request: {source: "screen"}, code: "unsupported"},
  ]
  for (const c of cases) {
    test(`${c.name} is refused with ${c.code}`, async () => {
      c.setup()
      const error = await startLease(c.request.packageName, "rt-1", c.request).catch((e: {code: string}) => e)
      expect((error as {code: string}).code).toBe(c.code)
      expect(coordinator.getLeaseSnapshot()).toBeNull()
      expect(lines.some((l) => l.includes("phase=refused") && l.includes(`code=${c.code}`))).toBe(true)
    })
  }

  test("the meeting owner with CAMERA gets a lease bound to that meeting", async () => {
    meetings.join(PKG)
    const lease = await startLease()
    expect(lease).toEqual({handleId: "id1", previewTraceId: "id2", source: "call"})
    expect(coordinator.getLeaseSnapshot()).toMatchObject({packageName: PKG, meetingId: "m1", state: "held"})
    await flush()
    expect(notified).toEqual([{handleId: "id1", state: "held"}])
  })

  test("a meeting replaced by a new one never inherits the old lease", async () => {
    meetings.join(PKG)
    await startLease()
    // A new join without the old one's release reaching us yet.
    meetings.join(PKG)
    const second = await startLease()
    expect(notified.find((e) => e.state === "ended")).toEqual({handleId: "id1", state: "ended", reason: "source_ended"})
    expect(coordinator.getLeaseSnapshot()).toMatchObject({handleId: second.handleId, meetingId: "m2"})
    // Another miniapp's meeting: the old owner is refused outright.
    meetings.join(OTHER)
    const error = await startLease().catch((e: {code: string}) => e)
    expect((error as {code: string}).code).toBe("not_meeting_owner")
  })
})

describe("single holder", () => {
  test("a second request is rejected with preview_busy and the first keeps delivering", async () => {
    await running()
    const error = await startLease(PKG, "rt-9").catch((e: {code: string}) => e)
    expect((error as {code: string}).code).toBe("preview_busy")
    expect(coordinator.isProducing()).toBe(true)
    expect(native.count("stop")).toBe(0)
  })
})

describe("lease lifetime", () => {
  test("survives the WebView being destroyed", async () => {
    await running()
    coordinator.viewDestroyed(PKG, "miniapp-unmounted")
    await flush()
    expect(coordinator.getLeaseSnapshot()).not.toBeNull()
    expect(native.calls.slice(-2)).toEqual(["stop:miniapp-unmounted", "unbind:miniapp-unmounted"])
    expect(notified.some((e) => e.state === "ended")).toBe(false)
  })

  test("ends when the meeting ends: background hears ended, page hears lease_ended, production stops", async () => {
    await running()
    meetings.end()
    await flush()
    expect(notified.at(-1)).toEqual({handleId: "id1", state: "ended", reason: "source_ended"})
    expect(ui.events()).toContain("lease_ended:source_ended")
    expect(native.calls.at(-1)).toBe("stop:source_ended")
    expect(coordinator.getLeaseSnapshot()).toBeNull()
  })

  test("ends on handle.stop()", async () => {
    const {lease} = await running()
    await coordinator.stop({packageName: PKG, runtimeId: "rt-1", handleId: lease.handleId})
    expect(notified.at(-1)).toEqual({handleId: lease.handleId, state: "ended", reason: "stopped"})
    expect(native.calls.at(-1)).toBe("stop:stopped")
  })

  test("ends when the runtime stops, and a restarted runtime cannot use the old handle", async () => {
    const {lease} = await running()
    await coordinator.stop({packageName: PKG, runtimeId: "rt-2", handleId: lease.handleId})
    expect(coordinator.getLeaseSnapshot()).not.toBeNull()
    expect(coordinator.getCounters().staleControlOps).toBe(1)
    coordinator.releaseRuntime(PKG, "rt-2", "runtime_replaced")
    expect(coordinator.getLeaseSnapshot()).not.toBeNull()
    coordinator.releaseRuntime(PKG, "rt-1", "runtime_replaced")
    expect(coordinator.getLeaseSnapshot()).toBeNull()
    expect(notified.at(-1)).toMatchObject({state: "ended", reason: "runtime_replaced"})
  })
})

describe("document generation", () => {
  test("bumps on ready only; repeated handshakes in one document reuse its credential", async () => {
    await running()
    const first = result(await page({cmd: "handshake", docGen: 1, mountEpoch: 1}))
    const second = result(await page({cmd: "handshake", docGen: 1, mountEpoch: 1}))
    expect(first.docGen).toBe(1)
    expect(second.docGen).toBe(1)
    expect(native.prepared).toBe(1)
    coordinator.documentReady(PKG)
    const next = result(await page({cmd: "handshake", docGen: 0, mountEpoch: 1}))
    expect(next.docGen).toBe(2)
    expect(native.prepared).toBe(2)
    expect(lines.filter((l) => l.includes("phase=doc_gen")).map((l) => /trigger=(\S+)/.exec(l)![1])).toEqual([
      "ready",
      "ready",
    ])
  })

  test("bumps on content-process termination and stops the old document's production", async () => {
    const {identity} = await running()
    coordinator.documentEnded(PKG, "content_process_terminated")
    await flush()
    expect(native.calls.at(-1)).toBe("stop:new_document")
    const stale = result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    expect(stale).toEqual({stale: true})
  })
})

describe("races", () => {
  test("component mounts before arming finishes: waiting_for_lease, then lease_available, no polling", async () => {
    // A previous lease's native stop is still in flight, so the next preview() is arming.
    const {lease} = await running()
    native.holdStop = deferred()
    await coordinator.stop({packageName: PKG, runtimeId: "rt-1", handleId: lease.handleId})
    coordinator.documentReady(PKG)
    const arming = startLease()
    const waiting = result(await page({cmd: "handshake", docGen: 0, mountEpoch: 1}))
    expect(waiting).toEqual({t: "waiting_for_lease", docGen: 2})
    const pushesBefore = ui.pushes.length
    native.holdStop.resolve()
    await arming
    expect(ui.pushes.slice(pushesBefore).map((p) => p.payload.t)).toEqual(["lease_available"])
    const config = result(await page({cmd: "handshake", docGen: 2, mountEpoch: 1}))
    expect(config.t).toBe("config")
  })

  test("call ends while preview() is still resolving: preview() rejects with source_ended", async () => {
    const {lease} = await running()
    native.holdStop = deferred()
    await coordinator.stop({packageName: PKG, runtimeId: "rt-1", handleId: lease.handleId})
    const arming = startLease().catch((e: {code: string}) => e)
    meetings.end()
    native.holdStop.resolve()
    expect(((await arming) as {code: string}).code).toBe("source_ended")
    expect(coordinator.getLeaseSnapshot()).toBeNull()
  })

  test("call ends after preview() resolved: the handle ends and the page shows source_ended", async () => {
    await running()
    meetings.end()
    expect(notified.at(-1)).toMatchObject({state: "ended", reason: "source_ended"})
    expect(ui.events().at(-1)).toBe("lease_ended:source_ended")
  })

  test("a delayed stop from an old component after a new one started is dropped by mountEpoch", async () => {
    const {identity} = await running(1)
    result(await page({cmd: "start", ...identity, mountEpoch: 2}))
    const dropped = result(await page({cmd: "stop", ...identity, mountEpoch: 1}))
    expect(dropped).toEqual({stale: true})
    expect(coordinator.isProducing()).toBe(true)
    expect(native.count("stop")).toBe(0)
    expect(lines.some((l) => l.includes("phase=stale_control_op") && l.includes("field=mountEpoch"))).toBe(true)
  })

  test("backgrounding pauses production and foregrounding resumes the same mount; page visibility dedups", async () => {
    const {identity} = await running()
    coordinator.setAppActive(false)
    await flush()
    expect(native.calls.at(-1)).toBe("stop:paused_background")
    expect(ui.events()).toContain("paused_background")
    clock += 5000
    coordinator.setAppActive(true)
    await flush()
    expect(native.calls.at(-1)).toBe("start")
    expect(ui.events().at(-1)).toBe("resumed")
    expect(coordinator.getCounters().pausedBackgroundMs).toBe(5000)
    const starts = native.count("start")
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    expect(native.count("start")).toBe(starts)
  })

  test("a component that unmounted while backgrounded is not restarted on foreground", async () => {
    const {identity} = await running()
    coordinator.setAppActive(false)
    result(await page({cmd: "stop", ...identity, mountEpoch: 1}))
    coordinator.setAppActive(true)
    await flush()
    expect(native.calls.at(-1)).toBe("stop:paused_background")
  })
})

describe("identity on every control op", () => {
  const wrong: Array<{field: string; mutate: (req: Record<string, unknown>) => void}> = [
    {field: "docGen", mutate: (req) => (req.docGen = 99)},
    {field: "token", mutate: (req) => (req.token = "forged")},
    {field: "mountEpoch", mutate: (req) => (req.mountEpoch = 0)},
  ]
  for (const w of wrong) {
    test(`a stop with the wrong ${w.field} alone is dropped and counted`, async () => {
      const {identity} = await running()
      const request: Record<string, unknown> = {cmd: "stop", ...identity, mountEpoch: 1}
      w.mutate(request)
      expect(result(await page(request))).toEqual({stale: true})
      expect(coordinator.isProducing()).toBe(true)
      expect(coordinator.getCounters().staleControlOps).toBe(1)
      expect(lines.some((l) => l.includes(`field=${w.field}`))).toBe(true)
    })
  }

  for (const field of ["runtimeId", "handleId"] as const) {
    test(`a background stop with the wrong ${field} alone is dropped and counted`, async () => {
      const {lease} = await running()
      const request = {packageName: PKG, runtimeId: "rt-1", handleId: lease.handleId, [field]: "wrong"}
      await coordinator.stop(request)
      expect(coordinator.getLeaseSnapshot()).not.toBeNull()
      expect(coordinator.getCounters().staleControlOps).toBe(1)
      expect(lines.some((l) => l.includes(`field=${field}`))).toBe(true)
    })
  }

  test("another miniapp's page cannot drive the preview", async () => {
    const {identity} = await running()
    expect(result(await page({cmd: "stop", ...identity, mountEpoch: 1}, OTHER))).toEqual({stale: true})
    expect(coordinator.isProducing()).toBe(true)
  })
})

describe("sizing", () => {
  test("configures only on tier changes, and a zero box stops production", async () => {
    const {identity} = await running()
    for (const width of [300, 310, 320]) {
      result(await page({cmd: "configure", ...identity, mountEpoch: 1, boxWidth: width, boxHeight: 170}))
    }
    result(await page({cmd: "configure", ...identity, mountEpoch: 1, boxWidth: 1200, boxHeight: 675}))
    expect(native.calls.filter((c) => c.startsWith("configure"))).toEqual([
      "configure:320x180@15",
      "configure:640x360@15",
    ])
    expect(coordinator.getCounters().tierChanges).toBe(2)
    result(await page({cmd: "configure", ...identity, mountEpoch: 1, boxWidth: 0, boxHeight: 0}))
    await flush()
    expect(native.calls.at(-1)).toBe("stop:hidden")
  })

  test("never asks for more than the ceiling", async () => {
    const {identity} = await running()
    result(await page({cmd: "configure", ...identity, mountEpoch: 1, boxWidth: 2560, boxHeight: 1440}))
    expect(native.calls.at(-1)).toBe("configure:640x360@15")
  })
})

describe("unsupported", () => {
  test("a device without the WebView feature is refused as unsupported at handshake", async () => {
    native.bindResult = {installReloadRequired: false, unavailableReason: "webview_feature_missing"}
    meetings.join(PKG)
    await startLease()
    await coordinator.bindView({packageName: PKG, hostViewTag: 1})
    coordinator.documentReady(PKG)
    const reply = await page({cmd: "handshake", docGen: 0, mountEpoch: 1})
    expect(reply).toMatchObject({ok: false, error: {code: "unsupported"}})
  })

  test("an unknown native protocol version is refused as unsupported", async () => {
    native.protocolVersion = 2
    meetings.join(PKG)
    await startLease()
    await coordinator.bindView({packageName: PKG, hostViewTag: 1})
    coordinator.documentReady(PKG)
    expect(await page({cmd: "handshake", docGen: 0, mountEpoch: 1})).toMatchObject({
      ok: false,
      error: {code: "unsupported"},
    })
  })

  test("a handshake that arrives before the view is bound waits for the binding", async () => {
    meetings.join(PKG)
    await startLease()
    coordinator.documentReady(PKG)
    const requestId = "early"
    coordinator.handleUiRequest(PKG, requestId, {cmd: "handshake", docGen: 0, mountEpoch: 1})
    await flush()
    expect(ui.replies.has(requestId)).toBe(false)
    await coordinator.bindView({packageName: PKG, hostViewTag: 7})
    await flush()
    expect(result(ui.replies.get(requestId)!)).toMatchObject({t: "config", docGen: 1})
  })

  test("the reload-once fallback is counted", async () => {
    native.bindResult = {installReloadRequired: true}
    const outcome = await coordinator.bindView({packageName: PKG, hostViewTag: 1})
    expect(outcome).toEqual({installReloadRequired: true, available: true})
    coordinator.noteInstallReload(PKG)
    expect(coordinator.getCounters().installReloads).toBe(1)
  })
})

describe("native stops", () => {
  test("ack_timeout is reported to the page and production restarts on the page's next start", async () => {
    const {identity} = await running()
    native.emit("onStopped", {reason: "ack_timeout", docGen: 1})
    expect(ui.events().at(-1)).toBe("error:ack_timeout")
    expect(coordinator.isProducing()).toBe(false)
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    await flush()
    expect(native.calls.at(-1)).toBe("start")
  })

  test("a stop for an older document is ignored", async () => {
    await running()
    native.emit("onStopped", {reason: "transport_failed", docGen: 0})
    expect(coordinator.isProducing()).toBe(true)
  })

  test("pack_failed halts the mount epoch until a newer mount starts", async () => {
    const {identity} = await running()
    native.emit("onStopped", {reason: "pack_failed", docGen: 1})
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    await flush()
    expect(native.count("start")).toBe(1)
    result(await page({cmd: "start", ...identity, mountEpoch: 2}))
    await flush()
    expect(native.count("start")).toBe(2)
  })

  test("native status passes through unchanged, with host counters beside it", async () => {
    await running()
    const nativeStatus = {
      t: "status",
      deliveredFps: 14.9,
      outstanding: 1,
      acsSendFps: 29.7,
      tapFramesOffered: 30,
      tapTelemetry: true,
      installReloads: 0,
      handshakes: 3,
      packFailures: {sink_error: 1},
    }
    native.emit("onStatus", nativeStatus)
    const pushed = ui.pushes.at(-1)!.payload
    expect(pushed).toMatchObject(nativeStatus)
    expect(pushed.host).toMatchObject({staleControlOps: 0, installReloads: 0, handshakes: 1, faultsInjected: 0})
  })

  test("native echoes of the host's own stop reasons never change production state", async () => {
    const {identity} = await running()
    result(await page({cmd: "stop", ...identity, mountEpoch: 1}))
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    await flush()
    // The echo of the stop arrives after the restart.
    native.emit("onStopped", {reason: "page_stop", docGen: 1})
    expect(coordinator.isProducing()).toBe(true)
    expect(coordinator.getCounters().nativeStops).toEqual({})
    expect(lines.some((l) => l.includes("phase=native_stop_echo") && l.includes("reason=page_stop"))).toBe(true)
  })

  test("diagnostics_disabled from native is a typed, halting error", async () => {
    const {identity} = await running()
    native.emit("onStopped", {reason: "diagnostics_disabled", docGen: 1})
    expect(ui.events().at(-1)).toBe("error:diagnostics_disabled")
    expect(coordinator.getCounters().nativeStops).toEqual({diagnostics_disabled: 1})
    result(await page({cmd: "start", ...identity, mountEpoch: 1}))
    await flush()
    expect(native.count("start")).toBe(1)
  })
})

describe("native binding errors", () => {
  test("prepareDocument rejecting not_bound refuses the handshake as unsupported and stops asking", async () => {
    native.prepareError = {code: "not_bound"}
    meetings.join(PKG)
    await startLease()
    await coordinator.bindView({packageName: PKG, hostViewTag: 1})
    coordinator.documentReady(PKG)
    expect(await page({cmd: "handshake", docGen: 0, mountEpoch: 1})).toMatchObject({
      ok: false,
      error: {code: "unsupported"},
    })
    expect(await page({cmd: "handshake", docGen: 0, mountEpoch: 1})).toMatchObject({
      ok: false,
      error: {code: "unsupported"},
    })
    expect(native.prepared).toBe(1)
    expect(lines.some((l) => l.includes("phase=prepare_failed") && l.includes("code=not_bound"))).toBe(true)
  })
})

describe("native log forwarding", () => {
  test("native PREVIEW_TRACE lines reach the console at their level, redacted", async () => {
    native.emit("onLog", {level: "info", message: "[PREVIEW_TRACE] layer=native phase=attach gen=4 t=10"})
    native.emit("onLog", {
      level: "warn",
      message:
        "[PREVIEW_TRACE] layer=native phase=hello_rejected token=abc123 url=ws://127.0.0.1:4100/p?token=abc123 t=11",
    })
    native.emit("onLog", {level: "warn", message: 'listener at ws://127.0.0.1:4100/p?token=abc123 {"token":"abc123"}'})
    expect(lines[0]).toBe("[PREVIEW_TRACE] layer=native phase=attach gen=4 t=10")
    expect(levels).toEqual(["log", "warn", "warn"])
    expect(lines[1]).toContain("phase=hello_rejected token=<redacted> url=<redacted>")
    expect(lines.join("\n")).not.toContain("abc123")
  })

  test("a malformed log event cannot break the coordinator", () => {
    native.emit("onLog", null)
    expect(lines.some((l) => l.includes("phase=coordinator_error") && l.includes("what=native_log"))).toBe(true)
  })
})

describe("fault injection", () => {
  const cases: Array<{
    kind: "ack_delay" | "ack_drop" | "transport_close" | "pack_throw" | "sink_throw"
    ms?: number
    stop: string
    halts: boolean
  }> = [
    {kind: "ack_delay", ms: 3000, stop: "ack_timeout", halts: false},
    {kind: "ack_drop", stop: "ack_timeout", halts: false},
    {kind: "transport_close", stop: "transport_failed", halts: false},
    {kind: "pack_throw", stop: "pack_failed", halts: true},
    {kind: "sink_throw", stop: "pack_failed", halts: true},
  ]
  for (const c of cases) {
    test(`${c.kind}: typed ${c.stop} to the page, counters and log lines, and the call is untouched`, async () => {
      diagnostics = true
      const {identity} = await running()
      await coordinator.injectFault({kind: c.kind, ms: c.ms})
      expect(native.faults).toEqual([c.ms === undefined ? {kind: c.kind} : {kind: c.kind, ms: c.ms}])
      expect(native.diagnosticsEnabled).toBe(true)
      expect(coordinator.getCounters().faultsInjected).toBe(1)
      expect(lines.some((l) => l.includes("phase=fault_injected") && l.includes(`kind=${c.kind}`))).toBe(true)

      // What native reports once the fault bites.
      native.emit("onStatus", {t: "status", tapSinkExceptions: c.kind === "sink_throw" ? 1 : 0, acsSendFps: 30})
      native.emit("onStopped", {reason: c.stop, docGen: identity.docGen})
      expect(ui.pushes.find((p) => p.payload.t === "status")!.payload).toMatchObject({
        tapSinkExceptions: c.kind === "sink_throw" ? 1 : 0,
        acsSendFps: 30,
      })
      expect(ui.events().at(-1)).toBe(`error:${c.stop}`)
      expect(coordinator.getCounters().nativeStops).toEqual({[c.stop]: 1})
      expect(lines.some((l) => l.includes("phase=native_stopped") && l.includes(`reason=${c.stop}`))).toBe(true)
      expect(coordinator.isProducing()).toBe(false)

      result(await page({cmd: "start", ...identity, mountEpoch: 1}))
      await flush()
      expect(native.count("start")).toBe(c.halts ? 1 : 2)
      expect(new Set(meetings.touched)).toEqual(new Set(["current", "onReleased"]))
      expect(coordinator.getLeaseSnapshot()).not.toBeNull()
    })
  }

  test("clear disarms without stopping anything", async () => {
    diagnostics = true
    await running()
    await coordinator.injectFault({kind: "clear"})
    expect(native.faults).toEqual([{kind: "clear"}])
    expect(coordinator.isProducing()).toBe(true)
  })

  test("outside debug builds and Super Mode it is refused before native is asked", async () => {
    await running()
    const error = await coordinator.injectFault({kind: "ack_drop"}).catch((e: {code: string}) => e)
    expect((error as {code: string}).code).toBe("diagnostics_disabled")
    expect(native.faults).toEqual([])
    expect(native.diagnosticsEnabled).toBe(false)
    expect(lines.some((l) => l.includes("phase=refused") && l.includes("code=diagnostics_disabled"))).toBe(true)
  })

  test("a native diagnostics_disabled rejection stays typed", async () => {
    diagnostics = true
    native.rejectFault = {code: "diagnostics_disabled"}
    await running()
    const error = await coordinator.injectFault({kind: "pack_throw"}).catch((e: {code: string}) => e)
    expect((error as {code: string}).code).toBe("diagnostics_disabled")
    expect(coordinator.getCounters().faultsInjected).toBe(0)
  })

  test("an unknown fault kind is unsupported", async () => {
    diagnostics = true
    const error = await coordinator.injectFault({kind: "melt"}).catch((e: {code: string}) => e)
    expect((error as {code: string}).code).toBe("unsupported")
  })

  test("the page can arm a fault over _preview only with the current identity and diagnostics on", async () => {
    const {identity} = await running()
    expect(await page({cmd: "injectFault", ...identity, mountEpoch: 1, kind: "ack_drop"})).toMatchObject({
      ok: false,
      error: {code: "diagnostics_disabled"},
    })
    diagnostics = true
    expect(result(await page({cmd: "injectFault", ...identity, mountEpoch: 1, kind: "ack_delay", ms: 500}))).toEqual({
      applied: true,
    })
    expect(native.faults).toEqual([{kind: "ack_delay", ms: 500}])
    expect(
      result(await page({cmd: "injectFault", ...identity, token: "forged", mountEpoch: 1, kind: "ack_drop"})),
    ).toEqual({
      stale: true,
    })
    expect(native.faults).toHaveLength(1)
  })
})

describe("isolation from the call", () => {
  test("a rejected native start never throws out of the coordinator and reports pack_failed", async () => {
    native.failStart = new Error("worker died")
    await running()
    await flush()
    expect(coordinator.isProducing()).toBe(false)
    expect(ui.events().at(-1)).toBe("error:pack_failed")
  })

  test("a native call that throws synchronously during a meeting release never reaches the meeting", async () => {
    await running()
    native.throwStopSync = true
    meetings.end()
    await flush()
    expect(meetings.listenerErrors).toEqual([])
    expect(new Set(meetings.touched)).toEqual(new Set(["current", "onReleased"]))
    expect(lines.some((l) => l.includes("phase=native_failed"))).toBe(true)
  })

  test("a throwing background notifier does not break lease teardown", async () => {
    meetings.join(PKG)
    await coordinator.start({packageName: PKG, runtimeId: "rt-1", source: "call", hasCamera: true}, () => {
      throw new Error("runtime gone")
    })
    meetings.end()
    expect(meetings.listenerErrors).toEqual([])
    expect(coordinator.getLeaseSnapshot()).toBeNull()
  })
})

describe("PREVIEW_TRACE", () => {
  test("key transitions carry correlation ids, and no token or tokenised URL ever appears", async () => {
    const {lease} = await running()
    coordinator.setAppActive(false)
    coordinator.setAppActive(true)
    meetings.end()
    await flush()
    const phases = lines.map((l) => /phase=(\S+)/.exec(l)![1])
    for (const phase of [
      "lease_arming",
      "lease_held",
      "bound",
      "doc_gen",
      "handshake_ok",
      "production_start",
      "paused_background",
      "resumed",
      "lease_ended",
    ]) {
      expect(phases).toContain(phase)
    }
    const held = lines.find((l) => l.includes("phase=lease_held"))!
    for (const key of ["previewTraceId=id2", "runtimeId=rt-1", `handleId=${lease.handleId}`, "meetingId=m1", "t="]) {
      expect(held).toContain(key)
    }
    expect(lines.find((l) => l.includes("phase=production_start"))).toContain("docGen=1")
    expect(lines.find((l) => l.includes("phase=production_start"))).toContain("mountEpoch=1")
    const all = lines.join("\n")
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain("127.0.0.1")
    expect(lines.every((l) => l.startsWith("[PREVIEW_TRACE] layer=host phase="))).toBe(true)
  })

  test("repeated identical warnings are rate limited to the first and a count every 10 s", async () => {
    await running()
    for (let i = 0; i < 5; i += 1) native.emit("onStopped", {reason: "transport_failed", docGen: 1})
    clock += 10_000
    native.emit("onStopped", {reason: "transport_failed", docGen: 1})
    const stopped = lines.filter((l) => l.includes("phase=native_stopped"))
    expect(stopped).toHaveLength(2)
    expect(stopped[1]).toContain("repeated=5")
  })
})
