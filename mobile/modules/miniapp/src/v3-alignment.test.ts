/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "./envelope"
import type {TranscriptionData} from "./modules/events"
import {MiniappValidationError} from "./modules/languages"
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
  type Subscribe = {
    subscriptions: Array<string | Record<string, unknown>>
    transcriptionListeners: Array<Record<string, unknown>>
  }
  const lastSubscribe = (transport: FakeTransport) =>
    parseEnvelope(transport.sent[transport.sent.length - 1]!)!.payload as Subscribe

  test("on() subscribes to transcription:auto on the cloud by default", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    const env = parseEnvelope(transport.sent[0]!)
    const payload = env!.payload as {type: string} & Subscribe
    expect(payload.type).toBe(MiniappRequestType.SUBSCRIBE)
    expect(payload.subscriptions).toContainEqual({stream: "transcription:auto", processing: "preferCloud"})
    expect(payload.transcriptionListeners).toEqual([
      {id: expect.any(String), stream: "transcription:auto", processing: "preferCloud"},
    ])
  })

  test("forLanguage('en-US', handler) subscribes to transcription:en-US", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.forLanguage("en-US", () => {})
    expect(lastSubscribe(transport).subscriptions).toContainEqual({
      stream: "transcription:en-US",
      processing: "preferCloud",
    })
  })

  test("forLanguage(['en-US', 'es-ES'], handler) subscribes to both", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.forLanguage(["en-US", "es-ES"], () => {}, {processing: "preferLocal"})
    // Last SUBSCRIBE envelope contains both.
    const payload = lastSubscribe(transport)
    expect(payload.subscriptions).toContainEqual({stream: "transcription:en-US", processing: "preferLocal"})
    expect(payload.subscriptions).toContainEqual({stream: "transcription:es-ES", processing: "preferLocal"})
  })

  test("localOnly also carries the forceLocal flag that older hosts read", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {}, {processing: "localOnly"})
    const payload = lastSubscribe(transport)
    expect(payload.subscriptions).toEqual([{stream: "transcription:auto", processing: "localOnly", forceLocal: true}])
    expect(payload.transcriptionListeners).toEqual([
      {id: expect.any(String), stream: "transcription:auto", processing: "localOnly", forceLocal: true},
    ])
  })

  test("the deprecated forceLocal means localOnly, and processing wins over it", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    const stop = session.transcription.on(() => {}, {forceLocal: true})
    expect(lastSubscribe(transport).subscriptions).toEqual([
      {stream: "transcription:auto", processing: "localOnly", forceLocal: true},
    ])
    stop()
    session.transcription.on(() => {}, {processing: "preferLocal", forceLocal: true})
    expect(lastSubscribe(transport).subscriptions).toEqual([{stream: "transcription:auto", processing: "preferLocal"}])
  })

  test("an unknown processing value throws before subscribing", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    expect(() => session.transcription.on(() => {}, {processing: "cloudOnly" as never})).toThrow(MiniappValidationError)
    expect(() => session.transcription.forLanguage("en-US", () => {}, {processing: "local" as never})).toThrow(
      MiniappValidationError,
    )
    expect(transport.sent).toHaveLength(0)
  })

  test("listeners with different processing on one stream each get an entry", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    const stopLocal = session.transcription.on(() => {}, {processing: "localOnly"})
    session.transcription.on(() => {}, {processing: "preferLocal"})

    let payload = lastSubscribe(transport)
    expect(payload.subscriptions).toEqual([
      {stream: "transcription:auto", processing: "preferCloud"},
      {stream: "transcription:auto", processing: "localOnly", forceLocal: true},
      {stream: "transcription:auto", processing: "preferLocal"},
    ])
    expect(payload.transcriptionListeners.map((listener) => listener.processing)).toEqual([
      "preferCloud",
      "localOnly",
      "preferLocal",
    ])

    stopLocal()
    payload = lastSubscribe(transport)
    expect(payload.subscriptions).toEqual([
      {stream: "transcription:auto", processing: "preferCloud"},
      {stream: "transcription:auto", processing: "preferLocal"},
    ])
  })

  test("listeners receive only the events tagged for their class", async () => {
    const {session, transport} = await connectedSession()
    const cloudText: string[] = []
    const preferLocalText: string[] = []
    const localText: string[] = []
    session.transcription.on((data) => cloudText.push(data.text))
    session.transcription.on((data) => preferLocalText.push(data.text), {processing: "preferLocal"})
    session.transcription.on((data) => localText.push(data.text), {processing: "localOnly"})

    for (const [text, transcriptionRoute] of [
      ["cloud", "default"],
      ["local", "forceLocal"],
      ["fallback", "all"],
    ]) {
      transport.deliverFromPhone({
        type: MiniappResponseType.EVENT,
        streamType: "transcription:en-US",
        transcriptionRoute,
        data: {text, isFinal: true},
      })
    }

    expect(cloudText).toEqual(["cloud", "fallback"])
    expect(preferLocalText).toEqual(["cloud", "fallback"])
    expect(localText).toEqual(["local", "fallback"])
  })

  test("an event addressed to one listener reaches only that listener, with its source", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    const cloud: TranscriptionData[] = []
    const preferLocal: TranscriptionData[] = []
    session.transcription.on((data) => cloud.push(data))
    session.transcription.on((data) => preferLocal.push(data), {processing: "preferLocal"})
    const ids = lastSubscribe(transport).transcriptionListeners.map((listener) => listener.id)

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "default",
      listenerId: ids[1],
      data: {text: "on device", isFinal: true, source: "local"},
    })

    expect(cloud).toEqual([])
    expect(preferLocal).toEqual([{text: "on device", isFinal: true, source: "local"}])
  })

  test("events from hosts without source get it from the transcript type", async () => {
    const {session, transport} = await connectedSession()
    const sources: string[] = []
    session.transcription.on((data) => sources.push(data.source))
    session.transcription.on((data) => sources.push(data.source), {processing: "localOnly"})

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "default",
      data: {type: "transcription", text: "cloud", isFinal: true},
    })
    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      transcriptionRoute: "forceLocal",
      data: {type: "local_transcription", text: "local", isFinal: true},
    })

    expect(sources).toEqual(["cloud", "local"])
  })

  test("legacy untagged transcription never reaches a localOnly listener", async () => {
    const {session, transport} = await connectedSession()
    const cloudText: string[] = []
    const localText: string[] = []
    session.transcription.on((data) => cloudText.push(data.text))
    session.transcription.on((data) => localText.push(data.text), {processing: "localOnly"})

    transport.deliverFromPhone({
      type: MiniappResponseType.EVENT,
      streamType: "transcription:en-US",
      data: {text: "legacy", isFinal: true},
    })

    expect(cloudText).toEqual(["legacy"])
    expect(localText).toEqual([])
  })

  test("removing the last localOnly listener leaves only the cloud entry for the stream", async () => {
    const {session, transport} = await connectedSession()
    transport.sent.length = 0
    session.transcription.on(() => {})
    const stopLocal = session.transcription.on(() => {}, {processing: "localOnly"})

    stopLocal()

    expect(lastSubscribe(transport).subscriptions).toEqual([{stream: "transcription:auto", processing: "preferCloud"}])
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
