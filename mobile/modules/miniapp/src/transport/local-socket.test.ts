/// <reference types="bun-types" />
import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {LocalSocketTransport} from "./local-socket"

/** A WebSocket whose open, message and close events the test fires by hand. */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static created: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closeCalls = 0
  onopen: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: {data: unknown}) => void) | null = null
  onclose: ((ev: {code: number; reason: string}) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.created.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  close(): void {
    this.closeCalls += 1
  }

  /** The handshake completes, even if close() was already called on the socket. */
  connect(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(data: string): void {
    this.onmessage?.({data})
  }

  closed(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({code, reason})
  }
}

const g = globalThis as unknown as {WebSocket: unknown}
let realWebSocket: unknown

beforeEach(() => {
  realWebSocket = g.WebSocket
  g.WebSocket = FakeWebSocket
  FakeWebSocket.created = []
})

afterEach(() => {
  g.WebSocket = realWebSocket
})

describe("LocalSocketTransport", () => {
  test("a later open() abandons a socket still connecting, which cannot replace the active one", async () => {
    const transport = new LocalSocketTransport({url: "ws://127.0.0.1:1"})
    const received: string[] = []
    const disconnects: string[] = []
    transport.onMessage((raw) => received.push(raw))
    transport.onDisconnect((reason) => disconnects.push(reason))

    const first = transport.open()
    const second = transport.open()
    const [stale, active] = FakeWebSocket.created
    expect(stale!.closeCalls).toBe(1)
    active!.connect()
    await second

    stale!.connect()
    await expect(first).rejects.toThrow("superseded")
    stale!.receive("from the abandoned socket")
    active!.receive("from the active socket")
    transport.send("outbound")
    stale!.closed()

    expect(received).toEqual(["from the active socket"])
    expect(active!.sent).toEqual(["outbound"])
    expect(stale!.sent).toEqual([])
    expect(disconnects).toEqual([])
    transport.close()
    expect(active!.closeCalls).toBe(1)
  })

  test("close() while connecting closes that socket and rejects its open()", async () => {
    const transport = new LocalSocketTransport({url: "ws://127.0.0.1:1"})
    const disconnects: string[] = []
    transport.onDisconnect((reason) => disconnects.push(reason))
    const opening = transport.open()
    const [socket] = FakeWebSocket.created
    transport.close()
    expect(socket!.closeCalls).toBe(1)

    socket!.closed(1006)
    await expect(opening).rejects.toThrow("closed before opening")
    expect(transport.isOpen()).toBe(false)
    expect(disconnects).toEqual([])
  })

  test("the active socket closing is a disconnect", async () => {
    const transport = new LocalSocketTransport({url: "ws://127.0.0.1:1"})
    const disconnects: string[] = []
    transport.onDisconnect((reason) => disconnects.push(reason))
    const opening = transport.open()
    FakeWebSocket.created[0]!.connect()
    await opening
    FakeWebSocket.created[0]!.closed(1001, "going away")
    expect(disconnects).toEqual(["closed: 1001 going away"])
    expect(transport.isOpen()).toBe(false)
  })
})
