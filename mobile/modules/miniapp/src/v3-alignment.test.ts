/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "./envelope"
import {MiniappRequestType, MiniappResponseType, MiniappStreamType} from "./protocol"
import {MiniappSession, type PermissionRecord} from "./session"
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

async function connectedSession(perms?: PermissionRecord) {
  const transport = new FakeTransport()
  const session = new MiniappSession({transport})
  const connectPromise = session.connect()
  transport.deliverFromPhone({
    type: MiniappResponseType.CONNECT_ACK,
    userId: "u",
    packageName: "com.test.v3",
    capabilities: null,
    permissions: perms,
  })
  await connectPromise
  return {transport, session}
}

describe("v3 alignment — module renames", () => {
  test("session exposes display, speaker, mic (renamed from layouts/audio/microphone)", async () => {
    const {session} = await connectedSession()
    expect(session.display).toBeDefined()
    expect(session.speaker).toBeDefined()
    expect(session.mic).toBeDefined()
    // Pre-rename names should be gone:
    expect((session as Record<string, unknown>).layouts).toBeUndefined()
    expect((session as Record<string, unknown>).audio).toBeUndefined()
    expect((session as Record<string, unknown>).microphone).toBeUndefined()
  })
})

describe("v3 alignment — session.permissions", () => {
  test("getAll() reflects CONNECT_ACK permissions", async () => {
    const {session} = await connectedSession({
      location: false,
      microphone: true,
      camera: false,
      notifications: true,
      calendar: false,
    })
    expect(session.permissions.getAll()).toEqual({
      location: false,
      microphone: true,
      camera: false,
      notifications: true,
      calendar: false,
    })
    expect(session.permissions.has("microphone")).toBe(true)
    expect(session.permissions.has("camera")).toBe(false)
  })

  test("PERMISSIONS_UPDATE push fires onUpdate", async () => {
    const {session, transport} = await connectedSession({
      location: false,
      microphone: false,
      camera: false,
      notifications: false,
      calendar: false,
    })

    const received: PermissionRecord[] = []
    session.permissions.onUpdate((r) => received.push(r))

    transport.deliverFromPhone({
      type: MiniappResponseType.PERMISSIONS_UPDATE,
      permissions: {location: true, microphone: true, camera: false, notifications: false, calendar: false},
    })

    expect(received.length).toBe(1)
    expect(received[0].location).toBe(true)
    expect(received[0].microphone).toBe(true)
    expect(session.permissions.has("location")).toBe(true)
  })

  test("missing permissions in CONNECT_ACK default to all-false", async () => {
    const {session} = await connectedSession()
    expect(session.permissions.getAll()).toEqual({
      location: false,
      microphone: false,
      camera: false,
      notifications: false,
      calendar: false,
    })
  })
})

describe("v3 alignment — module hasPermission getters", () => {
  test("mic.hasPermission reflects microphone declaration", async () => {
    const {session} = await connectedSession({
      location: false,
      microphone: true,
      camera: false,
      notifications: false,
      calendar: false,
    })
    expect(session.mic.hasPermission).toBe(true)
    expect(session.camera.hasPermission).toBe(false)
  })

  test("phone.notifications.hasPermission reflects notifications declaration", async () => {
    const {session} = await connectedSession({
      location: false,
      microphone: false,
      camera: false,
      notifications: true,
      calendar: false,
    })
    expect(session.phone.notifications.hasPermission).toBe(true)
    expect(session.phone.calendar.hasPermission).toBe(false)
  })
})

describe("v3 alignment — session.transcription", () => {
  test("on() subscribes to transcription:auto", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {type: string; subscriptions: string[]}
    expect(payload.type).toBe(MiniappRequestType.SUBSCRIBE)
    expect(payload.subscriptions).toContain("transcription:auto")
  })

  test("forLanguage('en-US', handler) subscribes to transcription:en-US", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.forLanguage("en-US", () => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain("transcription:en-US")
  })

  test("forLanguage(['en-US', 'es-ES'], handler) subscribes to both", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.forLanguage(["en-US", "es-ES"], () => {})
    // Last SUBSCRIBE envelope contains both.
    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain("transcription:en-US")
    expect(payload.subscriptions).toContain("transcription:es-ES")
  })

  test("forceLocal transcription is encoded as subscription metadata", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {}, {forceLocal: true})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: Array<string | {stream: string; forceLocal: boolean}>}
    expect(payload.subscriptions).toContainEqual({stream: "transcription:auto", forceLocal: true})
  })

  test("mixed listeners request both local and cloud routes for one stream", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    session.transcription.on(() => {}, {forceLocal: true})

    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {
      subscriptions: Array<string | {stream: string; forceLocal: boolean; includeCloud?: boolean}>
    }
    expect(payload.subscriptions).toContainEqual({
      stream: "transcription:auto",
      forceLocal: true,
      includeCloud: true,
    })
  })

  test("adding and removing a default listener updates an existing local-only route", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {}, {forceLocal: true})
    const stopCloud = session.transcription.on(() => {})

    let last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    let payload = last!.payload as {
      subscriptions: Array<string | {stream: string; forceLocal: boolean; includeCloud?: boolean}>
    }
    expect(payload.subscriptions).toContainEqual({
      stream: "transcription:auto",
      forceLocal: true,
      includeCloud: true,
    })

    stopCloud()

    last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    payload = last!.payload as {
      subscriptions: Array<string | {stream: string; forceLocal: boolean; includeCloud?: boolean}>
    }
    expect(payload.subscriptions).toContainEqual({stream: "transcription:auto", forceLocal: true})
  })

  test("mixed listeners receive only their routed transcription events", async () => {
    const {session, transport} = await connectedSession()
    const cloudText: string[] = []
    const localText: string[] = []
    session.transcription.on((data) => cloudText.push(data.text))
    session.transcription.on((data) => localText.push(data.text), {forceLocal: true})

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "default",
      data: {text: "cloud", isFinal: true},
    })
    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "forceLocal",
      data: {text: "local", isFinal: true},
    })
    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "all",
      data: {text: "fallback", isFinal: true},
    })

    expect(cloudText).toEqual(["cloud", "fallback"])
    expect(localText).toEqual(["local", "fallback"])
  })

  test("legacy untagged transcription never reaches a forceLocal listener", async () => {
    const {session, transport} = await connectedSession()
    const cloudText: string[] = []
    const localText: string[] = []
    session.transcription.on((data) => cloudText.push(data.text))
    session.transcription.on((data) => localText.push(data.text), {forceLocal: true})

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      data: {text: "legacy", isFinal: true},
    })

    expect(cloudText).toEqual(["legacy"])
    expect(localText).toEqual([])
  })

  test("removing the last forceLocal listener restores cloud transcription for the stream", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    const stopLocal = session.transcription.on(() => {}, {forceLocal: true})

    stopLocal()

    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: Array<string | {stream: string; forceLocal: boolean}>}
    expect(payload.subscriptions).toContain("transcription:auto")
    expect(payload.subscriptions).not.toContainEqual({stream: "transcription:auto", forceLocal: true})
  })

  test("configure() sends a TRANSCRIPTION_CONFIG envelope", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.configure({languageHints: ["en"], vocabulary: ["MentraOS"], diarization: true})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {
      type: string
      config: {languageHints: string[]; vocabulary: string[]; diarization: boolean}
    }
    expect(payload.type).toBe(MiniappRequestType.TRANSCRIPTION_CONFIG)
    expect(payload.config.languageHints).toEqual(["en"])
    expect(payload.config.vocabulary).toEqual(["MentraOS"])
    expect(payload.config.diarization).toBe(true)
  })

  test("stop() tears down all transcription subscriptions", async () => {
    const {session, transport} = await connectedSession()
    session.transcription.on(() => {})
    session.transcription.forLanguage("en-US", () => {})
    transport.sent.length = 0
    session.transcription.stop()
    // After stop(), the registry should send a SUBSCRIBE with empty list.
    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: string[]}
    expect(payload.subscriptions.length).toBe(0)
  })
})

describe("v3 alignment — session.translation", () => {
  test("forLanguagePair() subscribes to translation:from:to", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.translation.forLanguagePair("en-US", "es-ES", () => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain("translation:en-US:es-ES")
  })
})

describe("v3 alignment — session.input.onTouch overloads", () => {
  test("onTouch(handler) subscribes to bare touch_event", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.input.onTouch(() => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain(MiniappStreamType.TOUCH_EVENT)
  })

  test("onTouch('single_tap', handler) subscribes to touch_event:single_tap", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.input.onTouch("single_tap", () => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain("touch_event:single_tap")
  })

  test("onTouch(['a','b'], handler) subscribes to both gestures", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.input.onTouch(["swipe_up", "swipe_down"], () => {})
    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain("touch_event:swipe_up")
    expect(payload.subscriptions).toContain("touch_event:swipe_down")
  })
})

describe("v3 alignment — phone sub-namespacing", () => {
  test("phone.notifications.on() subscribes to phone_notification stream", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.phone.notifications.on(() => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {subscriptions: string[]}
    expect(payload.subscriptions).toContain(MiniappStreamType.PHONE_NOTIFICATION)
  })

  test("phone.calendar.listEvents() sends a bounded snapshot request", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    const request = session.phone.calendar.listEvents({
      startsAt: new Date("2026-07-16T12:00:00.000Z"),
      endsAt: "2026-07-17T12:00:00.000Z",
      limit: 20,
    })
    const env = parseEnvelope(transport.sent[0]!)
    expect(env!.payload).toEqual({
      type: MiniappRequestType.CALENDAR_LIST_EVENTS,
      startsAt: "2026-07-16T12:00:00.000Z",
      endsAt: "2026-07-17T12:00:00.000Z",
      limit: 20,
    })
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {events: [], truncated: false},
      },
      env!.requestId,
    )
    await expect(request).resolves.toEqual({events: [], truncated: false})
  })

  test("phone.notifications.stop() tears down all notification subs", async () => {
    const {session, transport} = await connectedSession()
    session.phone.notifications.on(() => {})
    transport.sent.length = 0
    session.phone.notifications.stop()
    const last = parseEnvelope(transport.sent[transport.sent.length - 1]!)
    const payload = last!.payload as {subscriptions: string[]}
    // Notification stream should be gone after stop().
    expect(payload.subscriptions).not.toContain(MiniappStreamType.PHONE_NOTIFICATION)
  })
})
