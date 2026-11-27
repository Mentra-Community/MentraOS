import {afterEach, beforeEach, describe, expect, it, spyOn} from "bun:test"

import devServerBridge from "../DevServerBridge"

/** A stand-in for the dev server's socket: the test plays the laptop's side. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null
  static opened: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: {data: string}) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    FakeWebSocket.last = this
    FakeWebSocket.opened.push(url)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  /** The laptop sends a frame. */
  serve(frame: object) {
    this.onmessage?.({data: JSON.stringify(frame)})
  }
}

const realWebSocket = globalThis.WebSocket
let logSpy: ReturnType<typeof spyOn>
let warnSpy: ReturnType<typeof spyOn>
const PACKAGE = "com.example.dev"
const CONSOLE = "ws://192.168.1.20:3001/__mentra_dev"
let checks: string[]

/** Open the connection; the server answers hello unless `answer` is false. */
function connect(answer = true): FakeWebSocket {
  devServerBridge.connect(PACKAGE, CONSOLE)
  const ws = FakeWebSocket.last!
  ws.onopen?.()
  if (answer) ws.serve({type: "hello-ack", protocol: "mentra-dev/1"})
  return ws
}

/** Settle queued promise callbacks. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  ;(globalThis as {WebSocket: unknown}).WebSocket = FakeWebSocket
  FakeWebSocket.opened = []
  logSpy = spyOn(console, "log").mockImplementation(() => {})
  warnSpy = spyOn(console, "warn").mockImplementation(() => {})
  checks = []
  devServerBridge.onCheck((pkg) => {
    checks.push(pkg)
  })
})

afterEach(() => {
  devServerBridge.disconnect(PACKAGE)
  devServerBridge.onCheck(null)
  ;(globalThis as {WebSocket: unknown}).WebSocket = realWebSocket
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

describe("DevServerBridge: a new build", () => {
  it("connects to the console URL the build recorded", () => {
    connect()
    expect(FakeWebSocket.opened).toEqual([CONSOLE])
    expect(JSON.parse(FakeWebSocket.last!.sent[0]!)).toEqual({type: "hello", protocol: "mentra-dev/1"})
  })

  it("asks for a check when the connection opens: builds made while nobody listened", async () => {
    connect()
    await flush()
    expect(checks).toEqual([PACKAGE])
  })

  it("asks for a check on reload and on respawn-bg alike: both mean a new build is ready", async () => {
    const ws = connect()
    await flush()
    checks = []
    ws.serve({type: "reload"})
    ws.serve({type: "respawn-bg"})
    await flush()
    expect(checks).toEqual([PACKAGE, PACKAGE])
  })

  it("asks for nothing before the server answers, or from a server that speaks another protocol", async () => {
    const ws = connect(false)
    await flush()
    expect(checks).toEqual([])
    ws.serve({type: "hello-ack", protocol: "mentra-dev/2"})
    await flush()
    expect(checks).toEqual([])
  })

  it("a failed check is logged and the connection keeps going", async () => {
    devServerBridge.onCheck(async () => {
      throw new Error("the address didn't answer")
    })
    const ws = connect()
    await flush()
    expect(warnSpy).toHaveBeenCalled()
    devServerBridge.onCheck((pkg) => {
      checks.push(pkg)
    })
    ws.serve({type: "reload"})
    await flush()
    expect(checks).toEqual([PACKAGE])
  })
})

describe("DevServerBridge: the connection", () => {
  it("connecting again to the same console while it is open keeps the one connection", () => {
    connect()
    devServerBridge.connect(PACKAGE, CONSOLE)
    expect(FakeWebSocket.opened).toEqual([CONSOLE])
  })

  it("a build from another console replaces the connection", () => {
    const first = connect()
    devServerBridge.connect(PACKAGE, "ws://192.168.1.21:3001/__mentra_dev")
    expect(first.closed).toBe(true)
    expect(FakeWebSocket.opened).toEqual([CONSOLE, "ws://192.168.1.21:3001/__mentra_dev"])
  })

  it("forwards logs once connected, keeps them while not, and drops them once disconnected", async () => {
    const ws = connect(false)
    devServerBridge.forwardLog(PACKAGE, "log", ["early"], 1, "background")
    expect(ws.sent).toHaveLength(1) // hello only
    ws.serve({type: "hello-ack", protocol: "mentra-dev/1"})
    expect(ws.sent.slice(1).map((frame) => JSON.parse(frame).args)).toEqual([["early"]])
    devServerBridge.forwardLog(PACKAGE, "warn", ["live"], 2, "ui")
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({type: "log", level: "warn", args: ["live"], source: "ui"})

    devServerBridge.disconnect(PACKAGE)
    expect(ws.closed).toBe(true)
    devServerBridge.forwardLog(PACKAGE, "log", ["after"], 3, "ui")
    expect(ws.sent.some((frame) => frame.includes("after"))).toBe(false)
    ws.serve({type: "reload"})
    await flush()
    // The socket's last frames after a disconnect check nothing.
    expect(checks).toEqual([PACKAGE])
  })
})
