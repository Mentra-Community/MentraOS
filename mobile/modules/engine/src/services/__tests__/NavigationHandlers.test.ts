/// <reference types="bun-types" />

import {beforeEach, expect, mock, test} from "bun:test"

let pendingStart: Promise<{ok: boolean}> | null = null
let state = "idle"
const listeners = new Set<(update: {kind: string}) => void>()
const stop = mock(async () => {
  state = "idle"
  return {ok: true}
})
const navigation = {
  addListener: (listener: (update: {kind: string}) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  addLocationListener: () => () => {},
  addRouteListener: () => () => {},
  getState: () => state,
  getSnapshot: () => null,
  start: mock(async () => {
    state = "navigating"
    return pendingStart ? await pendingStart : {ok: true}
  }),
  stop,
}
mock.module("../NavigationService", () => ({default: navigation}))
mock.module("../CloudClientService", () => ({cloudClientService: {}}))
mock.module("../../runtime/bootstrap", () => ({isFeatureEnabled: () => true}))
mock.module("@mentra/miniapp", () => ({
  MiniappErrorCode: {INTERNAL: "INTERNAL"},
  MiniappResponseType: {EVENT: "event"},
  MiniappStreamType: {},
}))
const {NavigationHandlers} = await import("../NavigationHandlers")
let handlers: InstanceType<typeof NavigationHandlers>

beforeEach(() => {
  listeners.clear()
  stop.mockClear()
  pendingStart = null
  state = "idle"
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
  for (const listener of listeners) listener({kind: "error"})
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
  expect(listeners.size).toBe(1)
})
