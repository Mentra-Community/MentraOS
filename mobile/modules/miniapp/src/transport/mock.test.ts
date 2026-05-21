import {describe, expect, test, beforeEach, mock} from "bun:test"
import {MockTransport} from "./mock"
import {parseEnvelope, serializeEnvelope, makeRequestId} from "../envelope"
import {MiniappRequestType, MiniappResponseType} from "../protocol"

function envelope(payload: object, requestId?: string): string {
  return serializeEnvelope(requestId === undefined ? {payload} : {payload, requestId})
}

describe("MockTransport", () => {
  test("open() resolves immediately and sets isOpen", async () => {
    const t = new MockTransport({silent: true})
    expect(t.isOpen()).toBe(false)
    await t.open()
    expect(t.isOpen()).toBe(true)
  })

  test("CONNECT triggers a synthetic CONNECT_ACK", async () => {
    const t = new MockTransport({silent: true})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    t.send(envelope({type: MiniappRequestType.CONNECT, packageName: "com.test.foo"}))
    // Delivery is async (queueMicrotask) so wait a tick.
    await new Promise((r) => queueMicrotask(() => r(null)))

    expect(received.length).toBe(1)
    const env = parseEnvelope(received[0])
    const payload = env!.payload as {type: string; userId: string; packageName: string}
    expect(payload.type).toBe(MiniappResponseType.CONNECT_ACK)
    expect(payload.userId).toBe("mock-user")
    expect(payload.packageName).toBe("com.test.foo")
  })

  test("CONNECT_ACK uses constructor packageName when CONNECT omits it", async () => {
    const t = new MockTransport({silent: true, packageName: "com.fallback.pkg"})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    t.send(envelope({type: MiniappRequestType.CONNECT}))
    await new Promise((r) => queueMicrotask(() => r(null)))

    const payload = parseEnvelope(received[0])!.payload as {packageName: string}
    expect(payload.packageName).toBe("com.fallback.pkg")
  })

  test("requests with requestId get a synthetic REQUEST_RESULT", async () => {
    const t = new MockTransport({silent: true})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    const requestId = makeRequestId()
    t.send(envelope({type: MiniappRequestType.LOCATION_POLL}, requestId))
    await new Promise((r) => queueMicrotask(() => r(null)))

    expect(received.length).toBe(1)
    const env = parseEnvelope(received[0])
    expect(env!.requestId).toBe(requestId)
    const payload = env!.payload as {type: string; ok: boolean; data: any}
    expect(payload.type).toBe(MiniappResponseType.REQUEST_RESULT)
    expect(payload.ok).toBe(true)
    expect(payload.data).toEqual({lat: 0, lng: 0, accuracy: 0, timestamp: expect.any(Number)})
  })

  test("PHOTO returns a placeholder data: URL", async () => {
    const t = new MockTransport({silent: true})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    t.send(envelope({type: MiniappRequestType.PHOTO}, "rid-1"))
    await new Promise((r) => queueMicrotask(() => r(null)))

    const payload = parseEnvelope(received[0])!.payload as {data: {photoUrl: string}}
    expect(payload.data.photoUrl.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("SUBSCRIBE silently no-ops (no events fire)", async () => {
    const t = new MockTransport({silent: true})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    t.send(envelope({type: MiniappRequestType.SUBSCRIBE, streams: ["transcription"]}))
    await new Promise((r) => queueMicrotask(() => r(null)))

    expect(received.length).toBe(0)
  })

  test("send() before open() throws", () => {
    const t = new MockTransport({silent: true})
    expect(() => t.send(envelope({type: MiniappRequestType.PING}))).toThrow()
  })

  test("close() emits disconnect once", () => {
    const t = new MockTransport({silent: true})
    const reasons: string[] = []
    t.onDisconnect((r) => reasons.push(r))
    // close before open is a no-op
    t.close()
    expect(reasons.length).toBe(0)
    // open then close
    void t.open()
    t.close()
    t.close() // idempotent
    expect(reasons.length).toBe(1)
  })

  test("STORAGE_GET returns null value", async () => {
    const t = new MockTransport({silent: true})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()

    t.send(envelope({type: MiniappRequestType.STORAGE_GET, key: "x"}, "rid"))
    await new Promise((r) => queueMicrotask(() => r(null)))

    const payload = parseEnvelope(received[0])!.payload as {data: {value: null}}
    expect(payload.data.value).toBe(null)
  })

  test("custom userId reflects in CONNECT_ACK", async () => {
    const t = new MockTransport({silent: true, userId: "custom"})
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    await t.open()
    t.send(envelope({type: MiniappRequestType.CONNECT, packageName: "x"}))
    await new Promise((r) => queueMicrotask(() => r(null)))
    const payload = parseEnvelope(received[0])!.payload as {userId: string}
    expect(payload.userId).toBe("custom")
  })
})
