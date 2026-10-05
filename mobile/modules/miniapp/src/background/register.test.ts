/// <reference types="bun-types" />

import {afterEach, expect, test} from "bun:test"

import {registerMiniapp} from "./register"

interface BridgeGlobal {
  __dispatch?: (iface: string, method: string, argsJson: string) => string | null
  __mentraDeliverBridgeRaw?: (raw: string) => void
  __mentraInitCallback?: (sessionId: string) => void
}

const g = globalThis as unknown as BridgeGlobal

afterEach(() => {
  delete g.__dispatch
  delete g.__mentraDeliverBridgeRaw
  delete g.__mentraInitCallback
})

/** Install a fake host that acks CONNECT; returns the payload types it received. */
function fakeHost(hostFeatures?: Record<string, boolean>) {
  const received: Array<Record<string, unknown>> = []
  g.__dispatch = (_iface, _method, argsJson) => {
    const [raw] = JSON.parse(argsJson) as [string]
    const {payload, requestId} = JSON.parse(raw) as {payload: Record<string, unknown>; requestId?: string}
    received.push(payload)
    if (payload.type === "miniapp_connect") {
      const ack = {type: "miniapp_connect_ack", packageName: "com.test", userId: "", hostFeatures}
      queueMicrotask(() => g.__mentraDeliverBridgeRaw?.(JSON.stringify({payload: ack, requestId})))
    }
    return null
  }
  return received
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const types = (received: Array<Record<string, unknown>>) => received.map((payload) => payload.type)

test("CONNECT announces READY, which is sent once the handler's promise settles", async () => {
  const received = fakeHost({initReady: true})
  let finishInit: () => void = () => {}
  registerMiniapp(() => new Promise<void>((resolve) => (finishInit = resolve)), {packageName: "com.test"})
  g.__mentraInitCallback?.("s1")
  await settle()
  expect(received[0]).toMatchObject({type: "miniapp_connect", initReady: true, sessionId: "s1"})
  expect(types(received)).not.toContain("miniapp_ready")

  finishInit()
  await settle()
  expect(received.filter((payload) => payload.type === "miniapp_ready")).toEqual([
    {type: "miniapp_ready", sessionId: "s1"},
  ])
})

test("a rejected handler still reports READY", async () => {
  const received = fakeHost({initReady: true})
  const error = console.error
  console.error = () => {}
  try {
    registerMiniapp(() => Promise.reject(new Error("init failed")), {packageName: "com.test"})
    g.__mentraInitCallback?.("s1")
    await settle()
    expect(types(received)).toContain("miniapp_ready")
  } finally {
    console.error = error
  }
})

test("an older host that does not advertise initReady never receives READY", async () => {
  const received = fakeHost()
  registerMiniapp(() => {}, {packageName: "com.test"})
  g.__mentraInitCallback?.("s1")
  await settle(5)
  expect(types(received)).toEqual(["miniapp_connect"])
})
