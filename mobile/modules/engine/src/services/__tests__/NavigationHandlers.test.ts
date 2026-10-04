/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

let pendingStart: Promise<{ok: boolean}> | null = null
let pendingStop: Promise<{ok: boolean}> | null = null
const listeners = new Map<string, (update: {message?: string}) => void>()
const stop = mock(async () => (pendingStop ? await pendingStop : {ok: true}))
mock.module("@mentra/crust", () => ({
  default: {
    addListener: (event: string, listener: (update: {message?: string}) => void) => {
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

beforeEach(async () => {
  pendingStart = null
  pendingStop = null
  await navigation.stop()
  stop.mockClear()
  handlers = new NavigationHandlers(
    () => {},
    () => {},
  )
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
  listeners.get("onNavError")?.({message: "route failed"})
  handlers.onDisconnect("maps")
  expect(stop).toHaveBeenCalledTimes(1)
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
