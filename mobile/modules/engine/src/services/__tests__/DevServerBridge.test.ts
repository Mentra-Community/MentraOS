import {afterEach, beforeEach, describe, expect, it, spyOn} from "bun:test"

import devServerBridge from "../DevServerBridge"

/** A stand-in for the dev server's socket: the test plays the laptop's side. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: {data: string}) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  /** The laptop sends a frame. */
  serve(frame: object) {
    this.onmessage?.({data: JSON.stringify(frame)})
  }
}

const realWebSocket = globalThis.WebSocket
let logSpy: ReturnType<typeof spyOn>
let warnSpy: ReturnType<typeof spyOn>
const PACKAGE = "com.example.dev"

function connect(): FakeWebSocket {
  devServerBridge.connect(PACKAGE, "http://192.168.1.20:3000", 3001)
  const ws = FakeWebSocket.last!
  ws.onopen?.()
  ws.serve({type: "hello-ack", protocol: "mentra-dev/1"})
  return ws
}

/** Settle queued promise callbacks. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  ;(globalThis as {WebSocket: unknown}).WebSocket = FakeWebSocket
  logSpy = spyOn(console, "log").mockImplementation(() => {})
  warnSpy = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  devServerBridge.disconnect(PACKAGE)
  devServerBridge.clearRespawnBackgroundHandler()
  ;(globalThis as {WebSocket: unknown}).WebSocket = realWebSocket
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

describe("DevServerBridge: a save that touched both layers", () => {
  it("reloads the screen only once the new background is up", async () => {
    const events: string[] = []
    let finishRespawn!: () => void
    devServerBridge.onRespawnBackground(async (pkg) => {
      events.push(`respawn-start ${pkg}`)
      await new Promise<void>((resolve) => (finishRespawn = resolve))
      events.push(`respawn-done ${pkg}`)
    })
    devServerBridge.onReload((pkg) => {
      events.push(`reload ${pkg}`)
    })
    const ws = connect()

    ws.serve({type: "respawn-bg"})
    ws.serve({type: "reload"})
    await flush()
    expect(events).toEqual([`respawn-start ${PACKAGE}`])

    finishRespawn()
    await flush()
    expect(events).toEqual([`respawn-start ${PACKAGE}`, `respawn-done ${PACKAGE}`, `reload ${PACKAGE}`])
  })

  it("still reloads when the respawn fails", async () => {
    const events: string[] = []
    devServerBridge.onRespawnBackground(async () => {
      throw new Error("bundle unavailable")
    })
    devServerBridge.onReload(() => {
      events.push("reload")
    })
    const ws = connect()
    ws.serve({type: "respawn-bg"})
    ws.serve({type: "reload"})
    await flush()
    expect(events).toEqual(["reload"])
  })

  it("never overlaps two respawns", async () => {
    const events: string[] = []
    const finishers: Array<() => void> = []
    devServerBridge.onRespawnBackground(async () => {
      events.push("respawn-start")
      await new Promise<void>((resolve) => finishers.push(resolve))
      events.push("respawn-done")
    })
    const ws = connect()
    ws.serve({type: "respawn-bg"})
    ws.serve({type: "respawn-bg"})
    await flush()
    expect(events).toEqual(["respawn-start"])
    finishers[0]!()
    await flush()
    expect(events).toEqual(["respawn-start", "respawn-done", "respawn-start"])
    finishers[1]!()
    await flush()
    expect(events).toEqual(["respawn-start", "respawn-done", "respawn-start", "respawn-done"])
  })

  it("reloads at once when nothing runs before it", async () => {
    const events: string[] = []
    devServerBridge.onReload(() => {
      events.push("reload")
    })
    const ws = connect()
    ws.serve({type: "reload"})
    await flush()
    expect(events).toEqual(["reload"])
  })
})
