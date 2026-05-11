/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "./envelope"
import {MiniappResponseType, MiniappStreamType} from "./protocol"
import {MiniappSession, type PermissionRecord} from "./session"
import type {SpeakerStateEvent} from "./modules/speaker"
import {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./transport/types"

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

  deliverFromPhone(payload: object, requestId?: string): void {
    const env = {payload, ...(requestId ? {requestId} : {})}
    this.messageHandler?.(serializeEnvelope(env as never))
  }
}

async function connected(perms?: PermissionRecord) {
  const transport = new FakeTransport()
  const session = new MiniappSession({transport})
  const connectPromise = session.connect()
  transport.deliverFromPhone({
    type: MiniappResponseType.CONNECT_ACK,
    userId: "u",
    packageName: "com.test.feat",
    capabilities: null,
    permissions: perms,
  })
  await connectPromise
  return {transport, session}
}

describe("session.speaker — state observability", () => {
  test("initial state is 'idle' and isPlaying is false", async () => {
    const {session} = await connected()
    expect(session.speaker.state).toBe("idle")
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("SPEAKER_STATE pushes flow through onStateChange and update getters", async () => {
    const {session, transport} = await connected()
    const events: SpeakerStateEvent[] = []
    session.speaker.onStateChange((e) => events.push(e))

    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "loading"})
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "playing"})
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "stopped", durationMs: 4200})

    expect(events.map((e) => e.state)).toEqual(["loading", "playing", "stopped"])
    expect(events[2].durationMs).toBe(4200)
    expect(session.speaker.state).toBe("stopped")
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("isPlaying returns true while state === 'playing'", async () => {
    const {session, transport} = await connected()
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "playing"})
    expect(session.speaker.isPlaying).toBe(true)
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "stopped"})
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("error state delivers errorCode + errorMessage", async () => {
    const {session, transport} = await connected()
    const events: SpeakerStateEvent[] = []
    session.speaker.onStateChange((e) => events.push(e))

    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "loading"})
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "error",
      errorCode: "TTS_UPSTREAM_ERROR",
      errorMessage: "503",
    })

    const err = events.find((e) => e.state === "error")
    expect(err).toBeDefined()
    expect(err!.errorCode).toBe("TTS_UPSTREAM_ERROR")
    expect(err!.errorMessage).toBe("503")
  })

  test("multiple onStateChange handlers all fire", async () => {
    const {session, transport} = await connected()
    const a: string[] = []
    const b: string[] = []
    session.speaker.onStateChange((e) => a.push(e.state))
    session.speaker.onStateChange((e) => b.push(e.state))
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "playing"})
    expect(a).toEqual(["playing"])
    expect(b).toEqual(["playing"])
  })

  test("onStateChange unsubscribe stops further events", async () => {
    const {session, transport} = await connected()
    const events: string[] = []
    const unsub = session.speaker.onStateChange((e) => events.push(e.state))
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "loading"})
    unsub()
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "playing"})
    expect(events).toEqual(["loading"])
  })
})

describe("session.phone.notifications.onDismissed", () => {
  test("subscribes to phone_notification_dismissed stream", async () => {
    const {session, transport} = await connected()
    transport.sent.length = 0
    session.phone.notifications.onDismissed(() => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain(MiniappStreamType.PHONE_NOTIFICATION_DISMISSED)
  })

  test("delivers events to handler", async () => {
    const {session, transport} = await connected()
    const received: Array<{notificationId: string}> = []
    session.phone.notifications.onDismissed((d) => received.push(d))
    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: MiniappStreamType.PHONE_NOTIFICATION_DISMISSED,
      data: {notificationId: "n1", notificationKey: "k1", packageName: "com.app", timestamp: 123},
    })
    expect(received.length).toBe(1)
    expect(received[0].notificationId).toBe("n1")
  })

  test("phone.notifications.stop() tears down both on and onDismissed", async () => {
    const {session, transport} = await connected()
    session.phone.notifications.on(() => {})
    session.phone.notifications.onDismissed(() => {})
    transport.sent.length = 0
    session.phone.notifications.stop()
    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).not.toContain(MiniappStreamType.PHONE_NOTIFICATION)
    expect(payload.subscriptions).not.toContain(MiniappStreamType.PHONE_NOTIFICATION_DISMISSED)
  })
})
