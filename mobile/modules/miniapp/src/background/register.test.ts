/// <reference types="bun-types" />

import {afterEach, expect, test} from "bun:test"

import type {MiniappSession} from "../session"
import type {Transport} from "../transport/types"
import {registerMiniapp} from "./register"

interface BridgeGlobal {
  __dispatch?: (iface: string, method: string, argsJson: string) => string | null
  __mentraDeliverBridgeRaw?: (raw: string) => void
  __mentraInitCallback?: (sessionId: string) => void
  __hostError?: (payloadJson: string) => void
  __mentraBackgroundSession?: MiniappSession
}

const g = globalThis as unknown as BridgeGlobal

afterEach(() => {
  g.__mentraBackgroundSession?.disconnect()
  delete g.__mentraBackgroundSession
  delete g.__dispatch
  delete g.__mentraDeliverBridgeRaw
  delete g.__mentraInitCallback
  delete g.__hostError
})

/**
 * Install a fake host that acks CONNECT; returns the payloads it received.
 * `ackConnect` decides per CONNECT whether the host answers it.
 */
function fakeHost(
  hostFeatures?: Record<string, boolean>,
  ackConnect: (payload: Record<string, unknown>) => boolean = () => true,
) {
  const received: Array<Record<string, unknown>> = []
  g.__dispatch = (_iface, _method, argsJson) => {
    const [raw] = JSON.parse(argsJson) as [string]
    const {payload, requestId} = JSON.parse(raw) as {payload: Record<string, unknown>; requestId?: string}
    received.push(payload)
    if (payload.type === "miniapp_connect" && ackConnect(payload)) {
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

/** Collect what the SDK reports to the host's crash controller. */
function captureHostErrors(): string[] {
  const reported: string[] = []
  g.__hostError = (payloadJson) => reported.push(payloadJson)
  return reported
}

const connects = (received: Array<Record<string, unknown>>) =>
  received.filter((payload) => payload.type === "miniapp_connect")

test("a CONNECT_ACK timeout sends CONNECT again instead of reporting a crash, and READY follows", async () => {
  const reported = captureHostErrors()
  let answered = 0
  // A host that stalls through the first handshake and answers the second.
  const received = fakeHost({initReady: true}, () => answered++ > 0)
  const warn = console.warn
  console.warn = () => {}
  try {
    registerMiniapp(() => {}, {packageName: "com.test", connectTimeoutMs: 20})
    g.__mentraInitCallback?.("s1")
    await settle(1_400)
  } finally {
    console.warn = warn
  }
  expect(reported).toEqual([])
  // Both CONNECTs belong to the same spawn, so the host's session check accepts the retry.
  expect(connects(received)).toEqual([
    {type: "miniapp_connect", packageName: "com.test", initReady: true, sessionId: "s1"},
    {type: "miniapp_connect", packageName: "com.test", initReady: true, sessionId: "s1"},
  ])
  expect(received.filter((payload) => payload.type === "miniapp_ready")).toEqual([
    {type: "miniapp_ready", sessionId: "s1"},
  ])
})

test("an init that awaits the handshake and makes a request finishes across a timeout, then reports READY", async () => {
  const reported = captureHostErrors()
  let answered = 0
  const received = fakeHost({initReady: true}, () => answered++ > 0)
  const host = g.__dispatch!
  // The host answers the storage request once it reaches it.
  g.__dispatch = (iface, method, argsJson) => {
    const result = host(iface, method, argsJson)
    const [raw] = JSON.parse(argsJson) as [string]
    const {payload, requestId} = JSON.parse(raw) as {payload: Record<string, unknown>; requestId?: string}
    if (payload.type === "miniapp_storage_get") {
      const reply = {type: "miniapp_request_result", success: true, data: {value: "stored"}}
      queueMicrotask(() => g.__mentraDeliverBridgeRaw?.(JSON.stringify({payload: reply, requestId})))
    }
    return result
  }
  const steps: string[] = []
  const warn = console.warn
  console.warn = () => {}
  try {
    registerMiniapp(
      async (session) => {
        const stored = session.sendRequest<{value: string}>({type: "miniapp_storage_get", key: "k"})
        await session.waitForReady()
        steps.push("ready")
        steps.push((await stored).value)
      },
      {packageName: "com.test", connectTimeoutMs: 20},
    )
    g.__mentraInitCallback?.("s1")
    await settle(1_400)
  } finally {
    console.warn = warn
  }
  expect(reported).toEqual([])
  expect(steps).toEqual(["ready", "stored"])
  expect(connects(received)).toHaveLength(2)
  // READY follows the completed init, and the request went out once, after the handshake.
  const types = received.map((payload) => payload.type)
  expect(types.filter((type) => type === "miniapp_storage_get")).toHaveLength(1)
  expect(types.indexOf("miniapp_storage_get")).toBeGreaterThan(types.lastIndexOf("miniapp_connect"))
  expect(types.at(-1)).toBe("miniapp_ready")
})

test("a second init drops the first session, which neither retries nor reports", async () => {
  const reported = captureHostErrors()
  const received = fakeHost({initReady: true}, (payload) => payload.sessionId === "s2")
  registerMiniapp(() => {}, {packageName: "com.test", connectTimeoutMs: 20})
  g.__mentraInitCallback?.("s1")
  await settle()
  g.__mentraInitCallback?.("s2")
  await settle(1_400)
  expect(reported).toEqual([])
  expect(connects(received).map((payload) => payload.sessionId)).toEqual(["s1", "s2"])
  expect(received.filter((payload) => payload.type === "miniapp_ready")).toEqual([
    {type: "miniapp_ready", sessionId: "s2"},
  ])
})

test("a transport failure is still reported to the host, once", async () => {
  const reported = captureHostErrors()
  let opens = 0
  const transport: Transport = {
    open: async () => {
      opens++
      throw new Error("bridge missing")
    },
    send: () => {},
    onMessage: () => {},
    onDisconnect: () => {},
    close: () => {},
    isOpen: () => false,
  }
  const error = console.error
  console.error = () => {}
  try {
    registerMiniapp(() => {}, {transport, packageName: "com.test", connectTimeoutMs: 20})
    g.__mentraInitCallback?.("s1")
    await settle(60)
  } finally {
    console.error = error
  }
  expect(opens).toBe(1)
  expect(reported).toHaveLength(1)
  expect(reported[0]).toContain("session.connect() failed: bridge missing")
})

test("a native bridge that throws on send is reported once instead of retried", async () => {
  const reported = captureHostErrors()
  let sends = 0
  g.__dispatch = () => {
    sends++
    throw new Error("native bridge gone")
  }
  const error = console.error
  console.error = () => {}
  try {
    registerMiniapp(() => {}, {packageName: "com.test", connectTimeoutMs: 20})
    g.__mentraInitCallback?.("s1")
    await settle(1_400)
  } finally {
    console.error = error
  }
  expect(sends).toBe(1)
  expect(reported).toHaveLength(1)
  expect(reported[0]).toContain("transport disconnected")
})

test("a handler that disconnects its own session is not reported as a crash", async () => {
  const reported = captureHostErrors()
  const received = fakeHost({initReady: true})
  registerMiniapp((session) => session.disconnect(), {packageName: "com.test"})
  g.__mentraInitCallback?.("s1")
  await settle(5)
  expect(reported).toEqual([])
  expect(connects(received)).toEqual([])
})
