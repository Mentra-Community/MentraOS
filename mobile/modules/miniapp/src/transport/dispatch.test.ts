/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {DispatchTransport} from "./dispatch"

interface BridgeGlobal {
  __dispatch?: (iface: string, method: string, argsJson: string) => string | null
  __mentraDeliverBridgeRaw?: (raw: string) => void
}

describe("DispatchTransport", () => {
  let calls: Array<{iface: string; method: string; argsJson: string}>

  beforeEach(() => {
    calls = []
    ;(globalThis as unknown as BridgeGlobal).__dispatch = (iface, method, argsJson) => {
      calls.push({iface, method, argsJson})
      return null
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as BridgeGlobal).__dispatch
    delete (globalThis as unknown as BridgeGlobal).__mentraDeliverBridgeRaw
  })

  test("isAvailable returns true when __dispatch is bound", () => {
    expect(DispatchTransport.isAvailable()).toBe(true)
  })

  test("isAvailable returns false when __dispatch is missing", () => {
    delete (globalThis as unknown as BridgeGlobal).__dispatch
    expect(DispatchTransport.isAvailable()).toBe(false)
  })

  test("open() throws if __dispatch is not installed", async () => {
    delete (globalThis as unknown as BridgeGlobal).__dispatch
    const t = new DispatchTransport()
    await expect(t.open()).rejects.toThrow(/__dispatch is not installed/)
  })

  test("send() forwards envelope through __dispatch with iface=__bridge, method=send", async () => {
    const t = new DispatchTransport()
    await t.open()
    t.send('{"type":"DISPLAY","text":"hi"}')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.iface).toBe("__bridge")
    expect(calls[0]!.method).toBe("send")
    // argsJson is a JSON-encoded single-element array containing the raw envelope.
    expect(JSON.parse(calls[0]!.argsJson)).toEqual(['{"type":"DISPLAY","text":"hi"}'])
  })

  test("send() before open() throws", () => {
    const t = new DispatchTransport()
    expect(() => t.send("x")).toThrow(/send\(\) before open\(\)/)
  })

  test("incoming messages routed via __mentraDeliverBridgeRaw fire onMessage handler", async () => {
    const t = new DispatchTransport()
    await t.open()
    const received: string[] = []
    t.onMessage((raw) => received.push(raw))
    const deliver = (globalThis as unknown as BridgeGlobal).__mentraDeliverBridgeRaw!
    expect(typeof deliver).toBe("function")
    deliver('{"type":"SUBSCRIBE_ACK"}')
    deliver('{"type":"EVENT","name":"button"}')
    expect(received).toEqual(['{"type":"SUBSCRIBE_ACK"}', '{"type":"EVENT","name":"button"}'])
  })

  test("close() detaches __mentraDeliverBridgeRaw and flips isOpen()", async () => {
    const t = new DispatchTransport()
    await t.open()
    expect(t.isOpen()).toBe(true)
    t.close()
    expect(t.isOpen()).toBe(false)
    expect((globalThis as unknown as BridgeGlobal).__mentraDeliverBridgeRaw).toBeUndefined()
  })

  test("send() after native __dispatch disappears triggers disconnect handler", async () => {
    const t = new DispatchTransport()
    await t.open()
    const reasons: string[] = []
    t.onDisconnect((reason) => reasons.push(reason))
    delete (globalThis as unknown as BridgeGlobal).__dispatch
    t.send("ignored")
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/disappeared/)
    expect(t.isOpen()).toBe(false)
  })

  test("__dispatch throwing surfaces as a disconnect, not an unhandled throw", async () => {
    const t = new DispatchTransport()
    await t.open()
    ;(globalThis as unknown as BridgeGlobal).__dispatch = () => {
      throw new Error("native exploded")
    }
    const reasons: string[] = []
    t.onDisconnect((reason) => reasons.push(reason))
    t.send("payload")
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/native exploded/)
  })
})
