/// <reference types="bun-types" />
/**
 * Headless integration harness: the real `<StreamPreview>`, `PreviewConnection`, credit loop and
 * parser, against a scripted host that answers `_preview` the way the Mentra App does and a fake
 * Android port that delivers the shared golden fixtures. Only WebGL is faked.
 */
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import {existsSync, readFileSync} from "node:fs"
import {join} from "node:path"

import {GlobalRegistrator} from "@happy-dom/global-registrator"
import {act, createElement} from "react"

import type {PreviewControlRequest, PreviewHostEvent} from "./stream-preview/controlChannel"
import type {ParsedFrame} from "./stream-preview/protocol"
import type {YuvRenderer, YuvRendererOptions} from "./stream-preview/yuvRenderer"
import type {StreamPreviewStatus} from "./StreamPreview"

const FIXTURES_DIR = join(import.meta.dir, "../../../frame-preview/fixtures")
const PORT_NAME = "HarnessPreviewPort"
const TOKEN = "preview-test-token"

type Root = {render(node: unknown): void; unmount(): void}

let createRoot: (container: Element) => Root
let StreamPreview: typeof import("./StreamPreview").StreamPreview
let setRendererFactory: typeof import("./StreamPreview").setStreamPreviewRendererFactoryForTests
let connectionModule: typeof import("./stream-preview/PreviewConnection")
let controlModule: typeof import("./stream-preview/controlChannel")
let traceModule: typeof import("./stream-preview/trace")

class FakePort {
  posted: string[] = []
  removed = 0
  private listeners = new Set<(event: {data: unknown}) => void>()
  addEventListener(_type: "message", handler: (event: {data: unknown}) => void): void {
    this.listeners.add(handler)
  }
  removeEventListener(_type: "message", handler: (event: {data: unknown}) => void): void {
    this.removed += 1
    this.listeners.delete(handler)
  }
  postMessage(message: string): void {
    this.posted.push(message)
  }
  emit(buffer: ArrayBuffer): void {
    for (const listener of [...this.listeners]) listener({data: buffer})
  }
  get listening(): boolean {
    return this.listeners.size > 0
  }
  acks(): Array<{gen: number; seq: number}> {
    return this.posted.map((m) => JSON.parse(m)).filter((m) => m.t === "ack")
  }
  hellos(): number {
    return this.posted.map((m) => JSON.parse(m)).filter((m) => m.t === "hello").length
  }
}

/** Answers `_preview` like the host coordinator: identity-checked, waiting until a lease exists. */
class ScriptedHost {
  leaseHeld = false
  docGen = 1
  handshakes = 0
  ops: PreviewControlRequest[] = []
  port = new FakePort()
  private listeners = new Set<(payload: unknown) => void>()

  readonly mentra = {
    request: async (channel: string, payload: unknown) => {
      if (channel !== "_preview") throw new Error(`unexpected channel ${channel}`)
      return this.handle(payload as PreviewControlRequest)
    },
    on: (channel: string, cb: (payload: unknown) => void) => {
      if (channel !== "_preview") return () => {}
      this.listeners.add(cb)
      return () => this.listeners.delete(cb)
    },
  }

  private handle(request: PreviewControlRequest): unknown {
    if (request.cmd === "handshake") {
      if (!this.leaseHeld) return {t: "waiting_for_lease", docGen: this.docGen}
      this.handshakes += 1
      return {
        t: "config",
        protocolVersion: 1,
        transport: "webmessage",
        portName: PORT_NAME,
        token: TOKEN,
        docGen: this.docGen,
      }
    }
    if (request.docGen !== this.docGen || request.token !== TOKEN) return {stale: true}
    this.ops.push(request)
    return {applied: true}
  }

  push(event: PreviewHostEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  opNames(): string[] {
    return this.ops.map((op) => `${op.cmd}:${op.mountEpoch}`)
  }
}

class FakeRenderer implements YuvRenderer {
  alive = true
  disposed = false
  drawn: ParsedFrame[] = []
  fit: string
  constructor(readonly options: YuvRendererOptions) {
    this.fit = options.fit ?? "contain"
  }
  setFit(fit: "contain" | "cover"): void {
    this.fit = fit
  }
  drawFrame(frame: ParsedFrame): number | null {
    if (!this.alive) return null
    this.drawn.push(frame)
    return 0.5
  }
  dispose(): void {
    this.disposed = true
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(): void {}
  disconnect(): void {
    FakeResizeObserver.instances = FakeResizeObserver.instances.filter((i) => i !== this)
  }
  static fire(): void {
    for (const instance of [...FakeResizeObserver.instances]) instance.cb()
  }
}

function fixture(file: string): ArrayBuffer {
  const bytes = readFileSync(join(FIXTURES_DIR, file))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const manifest: Array<{file: string; expect: string}> = existsSync(join(FIXTURES_DIR, "manifest.json"))
  ? JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"))
  : []

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

let host: ScriptedHost
let renderers: FakeRenderer[]
let traceLines: string[]
let box = {width: 360, height: 202}
let visibility: "visible" | "hidden" = "visible"
let container: HTMLElement
let root: Root | null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
  ;({createRoot} = (await import("react-dom/client")) as unknown as {createRoot: typeof createRoot})
  ;({StreamPreview, setStreamPreviewRendererFactoryForTests: setRendererFactory} = await import("./StreamPreview"))
  connectionModule = await import("./stream-preview/PreviewConnection")
  controlModule = await import("./stream-preview/controlChannel")
  traceModule = await import("./stream-preview/trace")
  Object.defineProperty(document, "visibilityState", {configurable: true, get: () => visibility})
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return {x: 0, y: 0, top: 0, left: 0, right: box.width, bottom: box.height, ...box, toJSON() {}} as DOMRect
  }
  ;(globalThis as {ResizeObserver?: unknown}).ResizeObserver = FakeResizeObserver
  Object.defineProperty(window, "devicePixelRatio", {configurable: true, value: 1})
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  host = new ScriptedHost()
  renderers = []
  traceLines = []
  box = {width: 360, height: 202}
  visibility = "visible"
  ;(window as unknown as Record<string, unknown>).mentra = host.mentra
  ;(window as unknown as Record<string, unknown>)[PORT_NAME] = host.port
  traceModule.setPreviewTraceSinkForTests((line) => traceLines.push(line))
  setRendererFactory((_canvas, options) => {
    const renderer = new FakeRenderer(options)
    renderers.push(renderer)
    return renderer
  })
  // A fresh document: new singleton, new handshake.
  connectionModule.setPreviewConnectionForTests(
    new connectionModule.PreviewConnection({channel: controlModule.createMentraControlChannel()}),
  )
  container = document.createElement("div")
  document.body.appendChild(container)
  root = null
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container.remove()
  connectionModule.setPreviewConnectionForTests(null)
  traceModule.setPreviewTraceSinkForTests()
  setRendererFactory(null)
})

async function mount(props: {onStatus?: (s: StreamPreviewStatus) => void; onError?: (c: string) => void} = {}) {
  root = createRoot(container)
  await act(async () => root!.render(createElement(StreamPreview, {fit: "cover", ...props})))
  await flush()
}

async function unmount() {
  await act(async () => root!.unmount())
  root = null
  await flush()
}

async function deliver(buffers: ArrayBuffer[]): Promise<void> {
  for (const buffer of buffers) {
    host.port.emit(buffer)
    await flush()
  }
}

describe("<StreamPreview> against a scripted host", () => {
  test("waits for the lease, then handshakes on lease_available and renders golden frames zero-copy", async () => {
    const statuses: StreamPreviewStatus[] = []
    await mount({onStatus: (s) => statuses.push(s)})
    expect(statuses.at(-1)?.state).toBe("waiting_for_lease")
    expect(host.ops).toEqual([])

    host.leaseHeld = true
    host.push({t: "lease_available"})
    await flush()
    expect(host.handshakes).toBe(1)
    expect(host.port.hellos()).toBe(1)
    expect(host.opNames()).toEqual(["configure:1", "start:1"])
    expect(host.ops[0]).toMatchObject({boxWidth: 360, boxHeight: 202})
    expect(statuses.at(-1)?.state).toBe("open")

    const valid = manifest.filter((entry) => entry.expect === "ok").map((entry) => fixture(entry.file))
    const rejected = manifest.filter((entry) => entry.expect !== "ok").map((entry) => fixture(entry.file))
    expect(valid.length).toBeGreaterThan(0)
    await deliver(valid)
    await deliver(rejected)

    const renderer = renderers[0]!
    // Zero-copy guard: every plane the renderer receives is a view onto the delivered buffer.
    expect(renderer.drawn).toHaveLength(valid.length)
    renderer.drawn.forEach((frame, index) => {
      expect(frame.y.buffer).toBe(valid[index]!)
      if (frame.pixelFormat === "i420") {
        expect(frame.u.buffer).toBe(valid[index]!)
        expect(frame.v.buffer).toBe(valid[index]!)
      } else {
        expect(frame.uv.buffer).toBe(valid[index]!)
      }
    })
    // One ack per valid frame; none for a rejected one.
    expect(host.port.acks()).toHaveLength(valid.length)
    expect(renderer.fit).toBe("cover")
    expect(traceLines.join("\n")).not.toContain(TOKEN)
    expect(traceLines.some((l) => l.includes("phase=parse_reject"))).toBe(true)
  })

  test("unmount stops production but keeps the connection; remount starts without a handshake", async () => {
    host.leaseHeld = true
    await mount()
    expect(host.opNames()).toEqual(["configure:1", "start:1"])
    await unmount()
    expect(host.opNames()).toEqual(["configure:1", "start:1", "stop:1"])
    expect(host.port.listening).toBe(true)
    expect(renderers[0]!.disposed).toBe(true)

    await mount()
    expect(host.handshakes).toBe(1)
    expect(host.opNames()).toEqual(["configure:1", "start:1", "stop:1", "start:2"])
    await deliver([fixture(manifest.find((e) => e.expect === "ok")!.file)])
    expect(renderers[1]!.drawn).toHaveLength(1)
    expect(renderers[0]!.drawn).toHaveLength(0)
  })

  test("a reload is a new document and handshakes again", async () => {
    host.leaseHeld = true
    await mount()
    await unmount()
    connectionModule.setPreviewConnectionForTests(
      new connectionModule.PreviewConnection({channel: controlModule.createMentraControlChannel()}),
    )
    host.docGen = 2
    await mount()
    expect(host.handshakes).toBe(2)
    expect(host.ops.at(-1)).toMatchObject({cmd: "start", docGen: 2, mountEpoch: 1})
  })

  test("losing the lease closes the transport and reports source_ended", async () => {
    host.leaseHeld = true
    const errors: string[] = []
    const statuses: StreamPreviewStatus[] = []
    await mount({onError: (code) => errors.push(code), onStatus: (s) => statuses.push(s)})
    host.leaseHeld = false
    host.push({t: "lease_ended", reason: "source_ended"})
    await flush()
    expect(errors).toEqual(["source_ended"])
    expect(host.port.listening).toBe(false)
    expect(statuses.at(-1)).toMatchObject({state: "waiting_for_lease", reason: "source_ended"})
  })

  test("the page hiding stops production and showing restarts it, same mount epoch", async () => {
    host.leaseHeld = true
    await mount()
    visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    await flush()
    visibility = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    await flush()
    expect(host.opNames()).toEqual(["configure:1", "start:1", "stop:1", "start:1"])
    expect(host.handshakes).toBe(1)
  })

  test("host background pause is reported without touching the connection", async () => {
    host.leaseHeld = true
    const statuses: StreamPreviewStatus[] = []
    await mount({onStatus: (s) => statuses.push(s)})
    host.push({t: "paused_background"})
    host.push({t: "resumed"})
    await flush()
    expect(statuses.some((s) => s.paused)).toBe(true)
    expect(statuses.at(-1)?.paused).toBe(false)
    expect(host.handshakes).toBe(1)
  })

  test("a zero-size box is hidden: no start until it has a size", async () => {
    host.leaseHeld = true
    box = {width: 0, height: 0}
    await mount()
    expect(host.handshakes).toBe(0)
    box = {width: 600, height: 338}
    FakeResizeObserver.fire()
    await flush()
    expect(host.opNames()).toEqual(["configure:1", "start:1"])
    box = {width: 0, height: 0}
    FakeResizeObserver.fire()
    await flush()
    expect(host.opNames()).toEqual(["configure:1", "start:1", "stop:1"])
  })

  test("a resize storm sends one configure per tier change", async () => {
    host.leaseHeld = true
    box = {width: 200, height: 112}
    await mount()
    for (let width = 201; width <= 320; width += 7) {
      box = {width, height: Math.round(width * 0.5625)}
      FakeResizeObserver.fire()
    }
    for (let width = 330; width <= 640; width += 9) {
      box = {width, height: Math.round(width * 0.5625)}
      FakeResizeObserver.fire()
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 320)))
    await flush()
    const configures = host.ops.filter((op) => op.cmd === "configure")
    expect(configures).toHaveLength(2)
    expect(configures[1]).toMatchObject({boxWidth: 636})
  })

  test("WebGL context loss rebuilds the renderer and leaves the connection alone", async () => {
    host.leaseHeld = true
    await mount()
    const before = host.opNames()
    const first = renderers[0]!
    first.alive = false
    first.options.onError?.("webgl_context_lost")
    const canvas = container.querySelector("canvas")!
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    await flush()
    expect(renderers).toHaveLength(2)
    expect(first.disposed).toBe(true)
    expect(host.handshakes).toBe(1)
    expect(host.opNames()).toEqual([...before, "rendererError:1"])
    await deliver([fixture(manifest.find((e) => e.expect === "ok")!.file)])
    expect(renderers[1]!.drawn).toHaveLength(1)
  })
})
