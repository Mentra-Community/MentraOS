/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "./envelope"
import {MiniappRequestType, MiniappResponseType} from "./protocol"
import {MiniappSession} from "./session"
import {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./transport/types"

/**
 * A hand-rolled fake transport that lets the test drive both halves of the bridge.
 * Records every raw message the session sends, and lets the test push raw messages
 * back as if they came from the phone.
 */
class FakeTransport implements Transport {
  sent: string[] = []
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null
  private open_ = false

  async open(): Promise<void> {
    this.open_ = true
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
  }

  close(): void {
    this.open_ = false
  }

  isOpen(): boolean {
    return this.open_
  }

  /** Test helper: simulate an incoming message from the phone. */
  deliverFromPhone(payload: object, requestId?: string): void {
    const env = {payload, ...(requestId ? {requestId} : {})}
    this.messageHandler?.(serializeEnvelope(env as never))
  }

  /** Test helper: simulate a transport-level disconnect. */
  fireDisconnect(reason = "test"): void {
    this.disconnectHandler?.(reason)
  }
}

describe("MiniappSession queue-before-ACK", () => {
  test("calls made before CONNECT_ACK are buffered then flushed in FIFO order", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.queue"})

    // Kick connect — don't await. connect() runs synchronously up to await transport.open().
    const connectPromise = session.connect()

    // Call things BEFORE the phone responds with CONNECT_ACK. These should queue.
    session.display.showTextWall("queued-1")
    session.display.showTextWall("queued-2")
    expect(session.ready).toBe(false)

    // Let the connect() IIFE resume past `await transport.open()` so CONNECT is sent.
    await Promise.resolve()

    // At this point CONNECT should have been sent exactly once. Queued layouts not yet.
    expect(transport.sent.length).toBe(1)
    const connectEnvelope = parseEnvelope(transport.sent[0]!)
    expect(connectEnvelope).not.toBeNull()
    expect((connectEnvelope!.payload as {type: string}).type).toBe(MiniappRequestType.CONNECT)

    // Phone sends CONNECT_ACK.
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "user_abc",
      packageName: "com.test.queue",
      capabilities: null,
    })

    await connectPromise
    expect(session.ready).toBe(true)

    // After ACK the two queued calls should have been flushed in order.
    expect(transport.sent.length).toBe(3)
    const queued1 = parseEnvelope(transport.sent[1]!)
    const queued2 = parseEnvelope(transport.sent[2]!)
    // showTextWall produces {type: DISPLAY, view, layout: {layoutType, text}, durationMs}.
    expect((queued1!.payload as {layout: {text: string}}).layout.text).toBe("queued-1")
    expect((queued2!.payload as {layout: {text: string}}).layout.text).toBe("queued-2")
  })

  test("post-ACK calls bypass the queue", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.postack",
      capabilities: null,
    })
    await connectPromise

    const before = transport.sent.length
    session.display.showTextWall("hello post-ack")
    expect(transport.sent.length).toBe(before + 1)
  })
})

describe("MiniappSession auto-PONG", () => {
  test("session auto-replies to incoming PING requests", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.pong",
      capabilities: null,
    })
    await connectPromise

    const sentBefore = transport.sent.length
    transport.deliverFromPhone({type: MiniappRequestType.PING}, "req_ping_1")

    expect(transport.sent.length).toBe(sentBefore + 1)
    const reply = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    expect(reply).not.toBeNull()
    expect((reply!.payload as {type: string}).type).toBe(MiniappResponseType.PONG)
    expect(reply!.requestId).toBe("req_ping_1")
  })
})

describe("MiniappSession request correlation", () => {
  test("REQUEST_RESULT with matching requestId resolves the promise", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.req",
      capabilities: null,
    })
    await connectPromise

    const resultPromise = session.storage.get("my-key")
    // Find the requestId of the outbound storage_get.
    const outbound = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    expect(outbound!.requestId).toBeDefined()
    const reqId = outbound!.requestId!

    transport.deliverFromPhone(
      {type: MiniappResponseType.REQUEST_RESULT, ok: true, data: {value: "hello"}},
      reqId,
    )
    const value = await resultPromise
    expect(value).toBe("hello")
  })

  test("REQUEST_RESULT with ok=false rejects with the error", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.err",
      capabilities: null,
    })
    await connectPromise

    const promise = session.storage.set("k", "v")
    const outbound = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const reqId = outbound!.requestId!

    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: false,
        error: {code: "INTERNAL", message: "boom"},
      },
      reqId,
    )

    let caught: unknown
    try {
      await promise
    } catch (e) {
      caught = e
    }
    expect(caught).toEqual({code: "INTERNAL", message: "boom"})
  })
})

describe("MiniappSession event fan-out", () => {
  test("EVENT pushes hit event manager subscribers", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.events",
      capabilities: null,
    })
    await connectPromise

    const received: unknown[] = []
    const unsub = session.input.onButtonPress((d) => received.push(d))

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "button_press",
      data: {buttonId: "primary", pressType: "short"},
    })

    expect(received.length).toBe(1)
    expect((received[0] as {buttonId: string}).buttonId).toBe("primary")

    unsub()
  })

  test("subscribe sends SUBSCRIBE with current stream list", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.sub",
      capabilities: null,
    })
    await connectPromise

    session.input.onButtonPress(() => {})
    const outbound = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    expect((outbound!.payload as {type: string}).type).toBe(MiniappRequestType.SUBSCRIBE)
    expect((outbound!.payload as {subscriptions: string[]}).subscriptions).toContain("button_press")
  })
})

describe("MiniappSession visibility", () => {
  test("VISIBILITY_CHANGE updates session.visibility and fires event", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.vis",
      capabilities: null,
    })
    await connectPromise

    const values: string[] = []
    session.onVisibilityChange((v) => values.push(v))

    transport.deliverFromPhone({type: MiniappResponseType.VISIBILITY_CHANGE, visibility: "background"})
    expect(session.visibility).toBe("background")
    expect(values).toEqual(["background"])

    transport.deliverFromPhone({type: MiniappResponseType.VISIBILITY_CHANGE, visibility: "foreground"})
    expect(session.visibility).toBe("foreground")
    expect(values).toEqual(["background", "foreground"])
  })
})

describe("MiniappSession transport disconnect", () => {
  test("disconnect rejects pending requests and flips ready to false", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.disc",
      capabilities: null,
    })
    await connectPromise

    const promise = session.storage.get("k")
    transport.fireDisconnect("test disconnect")

    let caught: unknown
    try {
      await promise
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect((caught as {code: string}).code).toBe("NOT_CONNECTED")
    expect(session.ready).toBe(false)
  })
})
