/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "./envelope"
import {CLOUD_STATUS_STREAM} from "./modules/cloud"
import type {MeetingState} from "./modules/meeting"
import {MiniappRequestType, MiniappResponseType} from "./protocol"
import {ConnectAckTimeoutError, MiniappSession, NotConnectedError} from "./session"
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
  /** Makes the next open() reject with this error. */
  failNextOpen: Error | null = null
  opens = 0

  async open(): Promise<void> {
    this.opens += 1
    const error = this.failNextOpen
    this.failNextOpen = null
    if (error) throw error
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

describe("MiniappSession meeting termination details", () => {
  test("host end reason reaches listeners and cached state, then clears for the next call", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.meeting"})
    const connected = session.connect()
    await Promise.resolve()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.meeting",
    })
    await connected
    const events: MeetingState[] = []
    session.meeting.onState((state) => events.push(state))
    const endReason = {code: 404, subcode: 8543, message: "Meeting not found"}

    transport.deliverFromPhone({type: MiniappResponseType.MEETING_STATE, state: "error", muted: false, endReason})
    expect(events.at(-1)?.endReason).toEqual(endReason)
    expect(session.meeting.state.endReason).toEqual(endReason)

    transport.deliverFromPhone({type: MiniappResponseType.MEETING_STATE, state: "connecting", muted: false})
    expect(events.at(-1)?.endReason).toBeUndefined()
    expect(session.meeting.state.endReason).toBeUndefined()

    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_STATE,
      state: "error",
      muted: false,
      endReason: {code: "404", subcode: null, message: 8543},
    })
    expect(events.at(-1)?.endReason).toBeUndefined()
    expect(session.meeting.state.endReason).toBeUndefined()
    session.disconnect()
  })

  test("host videoEnabled reaches listeners and cached state", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.meeting"})
    const connected = session.connect()
    await Promise.resolve()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.meeting",
    })
    await connected
    const events: MeetingState[] = []
    session.meeting.onState((state) => events.push(state))

    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_STATE,
      state: "connected",
      muted: false,
      videoEnabled: false,
    })
    expect(events.at(-1)?.videoEnabled).toBe(false)
    expect(session.meeting.state.videoEnabled).toBe(false)

    transport.deliverFromPhone({type: MiniappResponseType.MEETING_STATE, state: "connected", muted: false})
    expect(session.meeting.state.videoEnabled).toBeUndefined()
    session.disconnect()
  })

  test("a publisher ceiling expiry is delivered, and a resume the caller sent is not an event", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.meeting"})
    const connected = session.connect()
    await Promise.resolve()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.meeting",
    })
    await connected
    const events: Array<{pauseId: string; status: "expired"}> = []
    session.meeting.onVideoPublisher((event) => events.push(event))

    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_VIDEO_PUBLISHER,
      pauseId: "pause-1",
      status: "expired",
    })
    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_VIDEO_PUBLISHER,
      pauseId: "pause-2",
      status: "resumed",
    })

    expect(events).toEqual([{pauseId: "pause-1", status: "expired"}])
    session.disconnect()
  })

  test("a later meeting event can change identity, and one that omits it keeps the last answer", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.meeting"})
    const connected = session.connect()
    await Promise.resolve()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.meeting",
    })
    await connected
    const events: MeetingState[] = []
    session.meeting.onState((state) => events.push(state))

    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_STATE,
      state: "connected",
      muted: false,
      identityMode: "guest",
      guestReason: "legacy-credential",
    })
    expect(events.at(-1)?.identityMode).toBe("guest")

    transport.deliverFromPhone({
      type: MiniappResponseType.MEETING_STATE,
      state: "connected",
      muted: false,
      identityMode: "teams-user",
      capabilities: {hangUpForEveryone: {allowed: true}},
    })
    expect(events.at(-1)?.identityMode).toBe("teams-user")
    expect(session.meeting.state.identityMode).toBe("teams-user")

    transport.deliverFromPhone({type: MiniappResponseType.MEETING_STATE, state: "connected", muted: true})
    expect(events.at(-1)?.identityMode).toBeUndefined()
    expect(session.meeting.state.identityMode).toBe("teams-user")
    session.disconnect()
  })
})

describe("MiniappSession queue-before-ACK", () => {
  test("calls made before CONNECT_ACK are buffered then flushed in FIFO order", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.queue"})

    // Kick connect — don't await. connect() runs synchronously up to await transport.open().
    const connectPromise = session.connect()

    // Call things BEFORE the phone responds with CONNECT_ACK. These should queue.
    // (sendOneShot is the public escape hatch — the same path every module's
    // fire-and-forget sends ride.)
    session.sendOneShot({type: "test_one_shot", text: "queued-1"})
    session.sendOneShot({type: "test_one_shot", text: "queued-2"})
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
    expect((queued1!.payload as {text: string}).text).toBe("queued-1")
    expect((queued2!.payload as {text: string}).text).toBe("queued-2")
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
    session.sendOneShot({type: "test_one_shot", text: "hello post-ack"})
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

describe("MiniappSession auth", () => {
  test("session.auth reads miniapp token from CONNECT_ACK", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "user_123",
      packageName: "com.test.auth",
      capabilities: null,
      auth: {
        mentraUserId: "user_123",
        oemId: "test-oem",
        token: "miniapp-token",
        expiresAt: Date.now() + 60_000,
      },
    })
    await connectPromise

    expect(await session.auth.getToken()).toBe("miniapp-token")
    expect(await session.auth.getAuthHeader()).toBe("Bearer miniapp-token")
    expect(session.auth.current?.mentraUserId).toBe("user_123")
  })

  test("session.auth waits for AUTH_UPDATE when token misses CONNECT_ACK", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "",
      packageName: "com.test.auth.update",
      capabilities: null,
    })
    await connectPromise

    const tokenPromise = session.auth.getToken()
    transport.deliverFromPhone({
      type: MiniappResponseType.AUTH_UPDATE,
      auth: {
        mentraUserId: "user_later",
        token: "later-token",
        expiresAt: Date.now() + 60_000,
      },
    })

    expect(await tokenPromise).toBe("later-token")
    expect(session.userId).toBe("user_later")
  })

  test("session.auth requests a fresh token when the cached token expires", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "user_expired",
      packageName: "com.test.auth.expired",
      capabilities: null,
      auth: {
        mentraUserId: "user_expired",
        token: "expired-token",
        expiresAt: Date.now() - 1_000,
      },
    })
    await connectPromise

    const tokenPromise = session.auth.getToken()
    const outbound = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    expect((outbound!.payload as {type?: string}).type).toBe(MiniappRequestType.AUTH_REFRESH)
    expect(outbound!.requestId).toBeDefined()

    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {
          auth: {
            mentraUserId: "user_expired",
            token: "fresh-token",
            expiresAt: Date.now() + 60_000,
          },
        },
      },
      outbound!.requestId!,
    )

    expect(await tokenPromise).toBe("fresh-token")
    expect(session.auth.current?.token).toBe("fresh-token")
  })

  test("session.auth.fetch attaches bearer token", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "user_fetch",
      packageName: "com.test.auth.fetch",
      capabilities: null,
      auth: {
        mentraUserId: "user_fetch",
        token: "fetch-token",
        expiresAt: Date.now() + 60_000,
      },
    })
    await connectPromise

    const originalFetch = globalThis.fetch
    let observedAuth = ""
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      observedAuth = new Headers(init?.headers).get("Authorization") ?? ""
      return Promise.resolve(new Response(JSON.stringify({ok: true}), {status: 200}))
    }) as typeof fetch

    try {
      const res = await session.auth.fetch("https://example.test/api", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
      })
      expect(res.status).toBe(200)
      expect(observedAuth).toBe("Bearer fetch-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("session.auth.fetch works when Headers is unavailable", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "user_fetch_no_headers",
      packageName: "com.test.auth.fetch.noheaders",
      capabilities: null,
      auth: {
        mentraUserId: "user_fetch_no_headers",
        token: "fetch-token-no-headers",
        expiresAt: Date.now() + 60_000,
      },
    })
    await connectPromise

    const originalFetch = globalThis.fetch
    const originalHeaders = globalThis.Headers
    let observedHeaders: HeadersInit | undefined
    globalThis.Headers = undefined as never
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = init?.headers
      return Promise.resolve(new Response(JSON.stringify({ok: true}), {status: 200}))
    }) as typeof fetch

    try {
      const res = await session.auth.fetch("https://example.test/api", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
      })
      expect(res.status).toBe(200)
      expect(observedHeaders).toEqual({
        "Content-Type": "application/json",
        "Authorization": "Bearer fetch-token-no-headers",
      })
    } finally {
      globalThis.fetch = originalFetch
      globalThis.Headers = originalHeaders
    }
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

    transport.deliverFromPhone({type: MiniappResponseType.REQUEST_RESULT, ok: true, data: {value: "hello"}}, reqId)
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

  test("cloud status pushes update session.cloud without sending SUBSCRIBE", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.cloud",
      capabilities: null,
    })
    await connectPromise

    const values: string[] = []
    const unsub = session.cloud.onStatusChanged((s) => values.push(`${s.status}:${s.audioTransport}`))
    const sentBefore = transport.sent.length

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: CLOUD_STATUS_STREAM,
      data: {status: "connected", audioTransport: "udp"},
    })

    expect(session.cloud.status).toEqual({status: "connected", audioTransport: "udp"})
    expect(session.cloud.connected).toBe(true)
    expect(values).toEqual(["disconnected:none", "connected:udp"])
    expect(transport.sent.length).toBe(sentBefore)

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

  test("disconnect rejects pending auth waiters instead of leaving them to time out", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    // CONNECT_ACK without an auth block, so getToken() must register a waiter
    // and wait for an AUTH_UPDATE that will never arrive once the transport drops.
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "",
      packageName: "com.test.auth.disc",
      capabilities: null,
    })
    await connectPromise

    const tokenPromise = session.auth.getToken()
    transport.fireDisconnect("test disconnect")

    let caught: unknown
    try {
      await tokenPromise
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect((caught as {code: string}).code).toBe("NOT_CONNECTED")
    expect((caught as Error).message).toContain("test disconnect")
  })

  test("CONNECT_ACK hostFeatures.captureAudio is stored for stream capture policy", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.hostfeatures",
      capabilities: null,
      hostFeatures: {captureAudio: true},
    })
    await connectPromise
    expect(session.hostFeatures).toEqual({captureAudio: true})
  })

  test("CONNECT_ACK without hostFeatures leaves captureAudio unsupported", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport})
    const connectPromise = session.connect()
    transport.deliverFromPhone({
      type: MiniappResponseType.CONNECT_ACK,
      userId: "u",
      packageName: "com.test.nohostfeatures",
      capabilities: null,
    })
    await connectPromise
    expect(session.hostFeatures).toBeNull()
  })
})

describe("MiniappSession connect retry", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const sentTypes = (transport: FakeTransport) =>
    transport.sent.map((raw) => (parseEnvelope(raw)?.payload as {type?: string} | undefined)?.type)
  const connectCount = (transport: FakeTransport) =>
    sentTypes(transport).filter((type) => type === MiniappRequestType.CONNECT).length
  const ack = (transport: FakeTransport, packageName: string) =>
    transport.deliverFromPhone({type: MiniappResponseType.CONNECT_ACK, userId: "u", packageName})

  test("a timed-out handshake can send CONNECT again", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.retry", connectTimeoutMs: 20})
    const first = session.connect()
    await Promise.resolve()
    expect(connectCount(transport)).toBe(1)
    await expect(first).rejects.toBeInstanceOf(ConnectAckTimeoutError)

    const second = session.connect()
    await Promise.resolve()
    expect(connectCount(transport)).toBe(2)
    // The transport is still open, so the retry only sends CONNECT again.
    expect(transport.opens).toBe(1)
    ack(transport, "com.test.retry")
    await second
    expect(session.ready).toBe(true)
    session.disconnect()
  })

  test("a CONNECT_ACK after the timeout completes the handshake without another CONNECT", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.late", connectTimeoutMs: 20})
    await expect(session.connect()).rejects.toBeInstanceOf(ConnectAckTimeoutError)

    ack(transport, "com.test.late")
    expect(session.ready).toBe(true)
    await session.connect()
    expect(connectCount(transport)).toBe(1)
    session.disconnect()
  })

  test("a CONNECT_ACK for an earlier CONNECT, after a later one completed the handshake, is ignored", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.dup", connectTimeoutMs: 20})
    let readies = 0
    let auths = 0
    session.on("ready", () => readies++)
    session.on("auth", () => auths++)
    await expect(session.connect()).rejects.toBeInstanceOf(ConnectAckTimeoutError)
    const second = session.connect()
    await Promise.resolve()
    const [firstId, secondId] = transport.sent
      .map((raw) => parseEnvelope(raw))
      .filter((envelope) => (envelope?.payload as {type?: string}).type === MiniappRequestType.CONNECT)
      .map((envelope) => envelope?.requestId)
    expect(firstId).not.toBe(secondId)

    const capabilities = {display: null}
    const auth = {mentraUserId: "u", token: "second", expiresAt: Date.now() + 60_000}
    transport.deliverFromPhone(
      {type: MiniappResponseType.CONNECT_ACK, userId: "u", packageName: "com.test.dup", capabilities, auth},
      secondId,
    )
    await second
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.CONNECT_ACK,
        userId: "stale",
        packageName: "com.test.dup",
        capabilities: null,
        configuration: {mode: "stale"},
        auth: {...auth, token: "first"},
      },
      firstId,
    )
    expect(readies).toBe(1)
    expect(auths).toBe(1)
    // The handshake's state is the one it completed with.
    expect(session.userId).toBe("u")
    expect(session.capabilities).toEqual(capabilities)
    expect(session._getConfiguration()).toEqual({})
    expect(session._getAuth()?.token).toBe("second")
    session.disconnect()
  })

  test("a handshake completed by a late CONNECT_ACK is not sent again after the transport drops", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.late-drop", connectTimeoutMs: 20})
    await expect(session.connect()).rejects.toBeInstanceOf(ConnectAckTimeoutError)
    ack(transport, "com.test.late-drop")
    transport.fireDisconnect("bridge threw")
    expect(session.ready).toBe(false)
    // Like a session whose own attempt was answered: connected once, it does not handshake again.
    await session.connect()
    expect(connectCount(transport)).toBe(1)
    session.disconnect()
  })

  test("disconnect during the handshake rejects connect() and cancels its timer", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.abort", connectTimeoutMs: 20})
    const errors: Error[] = []
    session.on("error", (error) => errors.push(error))
    const pending = session.connect()
    await Promise.resolve()
    session.disconnect()

    await expect(pending).rejects.toBeInstanceOf(NotConnectedError)
    await sleep(40)
    // A teardown is not an error, and the abandoned handshake reports no timeout.
    expect(errors).toEqual([])
    expect(connectCount(transport)).toBe(1)
  })

  test("a transport that failed to open can connect again", async () => {
    const transport = new FakeTransport()
    transport.failNextOpen = new Error("bridge missing")
    const session = new MiniappSession({transport, packageName: "com.test.open", connectTimeoutMs: 20})
    const errors: Error[] = []
    session.on("error", (error) => errors.push(error))
    await expect(session.connect()).rejects.toThrow("bridge missing")
    expect(connectCount(transport)).toBe(0)

    // The rejection is the report. The failed attempt's CONNECT_ACK timer is
    // gone too, so no timeout lands later.
    await sleep(40)
    expect(errors).toEqual([])

    const second = session.connect()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.opens).toBe(2)
    expect(connectCount(transport)).toBe(1)
    ack(transport, "com.test.open")
    await second
    expect(session.ready).toBe(true)
    session.disconnect()
  })

  test("a registerMiniapp session's waitForReady() spans a timed-out handshake", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.spans", connectTimeoutMs: 20})
    session.retryHandshakeOnTimeout()
    const errors: Error[] = []
    session.on("error", (error) => errors.push(error))
    let settled = false
    const ready = session.waitForReady().then(() => (settled = true))
    const warn = console.warn
    console.warn = () => {}
    try {
      await sleep(1_400)
    } finally {
      console.warn = warn
    }
    expect(settled).toBe(false)
    expect(connectCount(transport)).toBe(2)
    // A stalled host is not a session error.
    expect(errors).toEqual([])
    ack(transport, "com.test.spans")
    await ready
    expect(session.ready).toBe(true)
    session.disconnect()
  })

  test("a CONNECT_ACK during the retry pause completes the handshake without another CONNECT", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.pause", connectTimeoutMs: 20})
    session.retryHandshakeOnTimeout()
    const warn = console.warn
    console.warn = () => {}
    try {
      const ready = session.connect()
      await sleep(40)
      ack(transport, "com.test.pause")
      await ready
    } finally {
      console.warn = warn
    }
    await sleep(1_000)
    expect(connectCount(transport)).toBe(1)
    session.disconnect()
  })

  test("disconnect during the retry pause ends the handshake", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.pause-abort", connectTimeoutMs: 20})
    session.retryHandshakeOnTimeout()
    const warn = console.warn
    console.warn = () => {}
    try {
      const pending = session.connect()
      await sleep(40)
      session.disconnect()
      await expect(pending).rejects.toBeInstanceOf(NotConnectedError)
    } finally {
      console.warn = warn
    }
    await sleep(1_000)
    expect(connectCount(transport)).toBe(1)
  })

  test("a transport that drops during the handshake fails connect() at once", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.drop", connectTimeoutMs: 20})
    const errors: Error[] = []
    session.on("error", (error) => errors.push(error))
    const pending = session.connect()
    await Promise.resolve()
    transport.fireDisconnect("bridge threw")
    await expect(pending).rejects.toThrow("transport disconnected: bridge threw")
    await sleep(40)
    // No CONNECT_ACK timeout follows the failure.
    expect(errors).toEqual([])
    session.disconnect()
  })

  test("a registerMiniapp session reports a transport drop during the retry pause instead of retrying", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.pause-drop", connectTimeoutMs: 20})
    session.retryHandshakeOnTimeout()
    const warn = console.warn
    console.warn = () => {}
    try {
      const pending = session.connect()
      await sleep(40)
      transport.fireDisconnect("bridge threw")
      await expect(pending).rejects.toThrow("transport disconnected: bridge threw")
    } finally {
      console.warn = warn
    }
    await sleep(1_000)
    expect(connectCount(transport)).toBe(1)
    session.disconnect()
  })

  test("a registerMiniapp session reports a transport that never opens, without retrying", async () => {
    const transport = new FakeTransport()
    transport.open = () => new Promise<void>(() => {})
    const session = new MiniappSession({transport, packageName: "com.test.hung", connectTimeoutMs: 20})
    session.retryHandshakeOnTimeout()
    await expect(session.connect()).rejects.toThrow("transport did not open")
    expect(connectCount(transport)).toBe(0)
    session.disconnect()
  })

  test("disconnect while the transport is opening settles connect() and closes the late transport", async () => {
    const transport = new FakeTransport()
    let finishOpen: () => void = () => {}
    let closes = 0
    transport.open = () => new Promise<void>((resolve) => (finishOpen = resolve))
    transport.close = () => {
      closes += 1
    }
    const session = new MiniappSession({transport, packageName: "com.test.opening", connectTimeoutMs: 20})
    const pending = session.connect()
    session.disconnect()
    await expect(pending).rejects.toBeInstanceOf(NotConnectedError)
    const closedByDisconnect = closes
    finishOpen()
    await sleep(0)
    expect(closes).toBe(closedByDisconnect + 1)
    expect(connectCount(transport)).toBe(0)
  })

  for (const outcome of ["rejects", "resolves"] as const) {
    test(`an open() that ${outcome} after its attempt timed out leaves the next attempt alone`, async () => {
      const transport = new FakeTransport()
      let finishFirstOpen: (error?: Error) => void = () => {}
      const open = transport.open.bind(transport)
      transport.open = () => {
        if (transport.opens++ > 0) return open()
        return new Promise<void>((resolve, reject) => {
          finishFirstOpen = (error) => (error ? reject(error) : resolve())
        })
      }
      const session = new MiniappSession({transport, packageName: "com.test.stale", connectTimeoutMs: 20})
      await expect(session.connect()).rejects.toThrow("transport did not open")

      let settled = false
      const second = session.connect().finally(() => (settled = true))
      await sleep(0)
      expect(connectCount(transport)).toBe(1)
      finishFirstOpen(outcome === "rejects" ? new Error("late open failure") : undefined)
      await sleep(0)
      // The stale attempt neither fails the live one nor sends its own CONNECT.
      expect(settled).toBe(false)
      expect(connectCount(transport)).toBe(1)
      ack(transport, "com.test.stale")
      await second
      expect(session.ready).toBe(true)
      session.disconnect()
    })
  }

  test("a request rejected by a CONNECT_ACK timeout is not sent after a later handshake", async () => {
    const transport = new FakeTransport()
    const session = new MiniappSession({transport, packageName: "com.test.queue", connectTimeoutMs: 20})
    const first = session.connect()
    const request = session.sendRequest({type: MiniappRequestType.STORAGE_GET, key: "k"})
    session.sendOneShot({type: MiniappRequestType.DISPLAY, items: []})
    let caught: unknown
    try {
      await request
    } catch (error) {
      caught = error
    }
    expect((caught as {code: string}).code).toBe("NOT_CONNECTED")
    await expect(first).rejects.toBeInstanceOf(ConnectAckTimeoutError)

    const second = session.connect()
    await Promise.resolve()
    ack(transport, "com.test.queue")
    await second
    // The one-shot still goes out; the request its caller saw fail does not.
    expect(sentTypes(transport)).toEqual([
      MiniappRequestType.CONNECT,
      MiniappRequestType.CONNECT,
      MiniappRequestType.DISPLAY,
    ])
    session.disconnect()
  })
})
