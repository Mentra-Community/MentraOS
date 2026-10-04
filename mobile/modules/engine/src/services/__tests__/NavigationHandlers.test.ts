/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

let pendingStart: Promise<{ok: boolean}> | null = null
let pendingStop: Promise<{ok: boolean}> | null = null
const listeners = new Map<string, (update: {message?: string; terminal?: boolean}) => void>()
const stop = mock(async () => (pendingStop ? await pendingStop : {ok: true}))
mock.module("@mentra/crust", () => ({
  default: {
    addListener: (event: string, listener: (update: {message?: string; terminal?: boolean}) => void) => {
      listeners.set(event, listener)
      return {remove: () => listeners.delete(event)}
    },
    startNavigation: async () => (pendingStart ? await pendingStart : {ok: true}),
    stopNavigation: stop,
  },
}))
const {default: navigation} = await import("../NavigationService")
mock.module("../CloudClientService", () => ({cloudClientService: {}}))
mock.module("../../runtime/bootstrap", () => ({isFeatureEnabled: () => true}))
mock.module("@mentra/miniapp", () => ({
  MiniappErrorCode: {INTERNAL: "INTERNAL"},
  MiniappResponseType: {EVENT: "event"},
  MiniappStreamType: {},
}))
const {NavigationHandlers} = await import("../NavigationHandlers")
let handlers: InstanceType<typeof NavigationHandlers>
const sendResult = mock(() => {})

beforeEach(async () => {
  pendingStart = null
  pendingStop = null
  await navigation.stop()
  stop.mockClear()
  sendResult.mockClear()
  handlers = new NavigationHandlers(() => {}, sendResult)
})

const destination = {lat: 1, lng: 2}

test("stopping a miniapp releases its native trip and listeners", async () => {
  await handlers.handleStart("maps", destination)
  handlers.onDisconnect("maps")
  expect(stop).toHaveBeenCalledTimes(1)
  expect(handlers.isTripActive("maps")).toBe(false)
  expect(listeners.size).toBe(0)
})

test("unrelated miniapp disconnect does not stop navigation", async () => {
  await handlers.handleStart("maps", destination)
  handlers.onDisconnect("captions")
  expect(stop).not.toHaveBeenCalled()
  expect(handlers.isTripActive("maps")).toBe(true)
})

test("disconnect after a route error still releases native navigation", async () => {
  await handlers.handleStart("maps", destination)
  listeners.get("onNavError")?.({message: "route failed", terminal: true})
  handlers.onDisconnect("maps")
  expect(stop).toHaveBeenCalledTimes(1)
})

test("failed startup releases native navigation without waiting for disconnect", async () => {
  pendingStart = Promise.resolve({ok: false})
  await handlers.handleStart("maps", destination)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(handlers.isTripActive("maps")).toBe(false)
  expect(navigation.getSnapshot()).toBeNull()
})

test("native route error clears the trip snapshot", async () => {
  await handlers.handleStart("maps", destination)
  listeners.get("onNavError")?.({message: "route failed", terminal: true})
  expect(navigation.getState()).toBe("idle")
  expect(navigation.getSnapshot()).toBeNull()
})

test("native error during startup cannot be overwritten by late success", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = handlers.handleStart("maps", destination)
  listeners.get("onNavError")?.({message: "route failed", terminal: true})
  resolveStart({ok: true})
  await starting
  expect(navigation.getState()).toBe("idle")
  expect(navigation.getSnapshot()).toBeNull()
  expect(handlers.isTripActive("maps")).toBe(false)
})

test("disconnect during startup stops navigation and ignores late success", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = handlers.handleStart("maps", destination)
  handlers.onDisconnect("maps")
  expect(stop).toHaveBeenCalledTimes(1)
  resolveStart({ok: true})
  await starting
  expect(handlers.isTripActive("maps")).toBe(false)
})

test("another miniapp owning navigation keeps the trip alive", async () => {
  await handlers.handleStart("maps", destination)
  await handlers.handleStart("other", destination)
  handlers.onDisconnect("maps")
  expect(stop).not.toHaveBeenCalled()
  handlers.onDisconnect("other")
  expect(stop).toHaveBeenCalledTimes(1)
})

test("a stopped startup cannot remove ownership from a relaunched miniapp", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = handlers.handleStart("maps", destination)
  handlers.onDisconnect("maps")
  pendingStart = null
  await handlers.handleStart("maps", destination)
  resolveStart({ok: false})
  await starting
  expect(handlers.isTripActive("maps")).toBe(true)
  expect(listeners.size).toBeGreaterThan(0)
})

test("late startup completion cannot resurrect a stopped trip snapshot", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = navigation.start({lat: 1, lng: 2})
  await navigation.stop()
  resolveStart({ok: true})
  await starting
  expect(navigation.getState()).toBe("idle")
  expect(navigation.getSnapshot()).toBeNull()
})

test("late stop completion cannot clear a newer trip snapshot", async () => {
  let resolveStop!: (result: {ok: boolean}) => void
  pendingStop = new Promise((resolve) => {
    resolveStop = resolve
  })
  const stopping = navigation.stop()
  pendingStart = Promise.resolve({ok: true})
  await navigation.start({lat: 3, lng: 4})
  resolveStop({ok: true})
  await stopping
  expect(navigation.getState()).toBe("navigating")
  expect(navigation.getSnapshot()?.stops).toEqual([{lat: 3, lng: 4}])
})

test("older failed start cannot stop a newer successful start from the same miniapp", async () => {
  let resolveOld!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveOld = resolve
  })
  const older = handlers.handleStart("maps", destination, "old-start")
  pendingStart = null
  await handlers.handleStart("maps", {lat: 3, lng: 4}, "new-start")
  resolveOld({ok: false})
  await older
  expect(stop).not.toHaveBeenCalled()
  expect(handlers.isTripActive("maps")).toBe(true)
  expect(navigation.getSnapshot()?.stops).toEqual([{lat: 3, lng: 4}])
  expect(sendResult).toHaveBeenCalledWith("maps", "old-start", false, undefined, {
    code: "INTERNAL",
    message: "navigation startup canceled or replaced",
  })
})

test("older rejected start cannot stop its replacement", async () => {
  let rejectOld!: (reason: Error) => void
  pendingStart = new Promise((_resolve, reject) => {
    rejectOld = reject
  })
  const older = handlers.handleStart("maps", destination)
  pendingStart = null
  await handlers.handleStart("maps", {lat: 3, lng: 4})
  rejectOld(new Error("old request canceled"))
  await older
  expect(stop).not.toHaveBeenCalled()
  expect(handlers.isTripActive("maps")).toBe(true)
})

test("a still-connected miniapp receives cancellation for a stopped pending start", async () => {
  let resolveStart!: (result: {ok: boolean}) => void
  pendingStart = new Promise((resolve) => {
    resolveStart = resolve
  })
  const starting = handlers.handleStart("maps", destination, "pending-start")
  await handlers.handleStop("maps", "stop")
  resolveStart({ok: true})
  await starting
  expect(sendResult).toHaveBeenCalledWith("maps", "pending-start", false, undefined, {
    code: "INTERNAL",
    message: "navigation startup canceled or replaced",
  })
})

test("recoverable iOS reroute error preserves trip ownership and configuration", async () => {
  await handlers.handleStart("maps", {...destination, mode: "walking"})
  const snapshot = navigation.getSnapshot()
  listeners.get("onNavRerouting")?.({})
  // The iOS reroute failure event has no terminal flag.
  listeners.get("onNavError")?.({message: "reroute failed"})
  expect(navigation.getState()).toBe("rerouting")
  expect(navigation.getSnapshot()).toEqual(snapshot)
  expect(handlers.isTripActive("maps")).toBe(true)
  expect(stop).not.toHaveBeenCalled()
  handlers.onDisconnect("maps")
  expect(stop).toHaveBeenCalledTimes(1)
})
