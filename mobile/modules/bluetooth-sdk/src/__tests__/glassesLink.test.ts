import {beforeEach, describe, expect, it, jest} from "@jest/globals"

import type {GlassesWifiEvent, GlassesWifiHoldOptions} from "../glasses-wifi/service"

// The glasses Wi-Fi service and the glasses connection, faked: each hold records itself and can
// emit its link's changes; tests move the Wi-Fi link and the Bluetooth connection.
const mockHolds: Array<{consumer: string; released: boolean; emit: (event: GlassesWifiEvent) => void}> = []
const mockState = {
  fail: null as Error | null,
  up: false,
  upListeners: new Set<(up: boolean) => void>(),
  connected: false,
  connectionListeners: new Set<() => void>(),
}
jest.mock("../glasses-wifi/service", () => ({
  glassesWifiUp: () => mockState.up,
  onGlassesWifiUp: (listener: (up: boolean) => void) => {
    mockState.upListeners.add(listener)
    return () => mockState.upListeners.delete(listener)
  },
  holdGlassesWifi: async ({consumer}: GlassesWifiHoldOptions) => {
    if (mockState.fail) throw mockState.fail
    let listener: ((event: GlassesWifiEvent) => void) | undefined
    const hold = {consumer, released: false, emit: (event: GlassesWifiEvent) => listener?.(event)}
    mockHolds.push(hold)
    return {
      onChange: (next: typeof listener) => {
        listener = next
        return () => (listener = undefined)
      },
      ready: async () => ({ssid: "glasses", password: "", gateway: "192.168.43.1"}),
      release: async () => {
        hold.released = true
      },
    }
  },
}))
jest.mock("../glasses-wifi/connection", () => ({
  watchGlassesConnection: async () => {},
  glassesConnection: () => (mockState.connected ? {state: "connected", fullyBooted: true} : {state: "disconnected"}),
  onGlassesConnection: (listener: () => void) => {
    mockState.connectionListeners.add(listener)
    return () => mockState.connectionListeners.delete(listener)
  },
}))
const setWifi = (up: boolean) => {
  mockState.up = up
  mockState.upListeners.forEach((listener) => listener(up))
}
const setGlasses = (connected: boolean) => {
  mockState.connected = connected
  mockState.connectionListeners.forEach((listener) => listener())
}

const {createLink} = jest.requireActual<typeof import("../glasses-wifi/link")>("../glasses-wifi/link")
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("link", () => {
  beforeEach(() => {
    mockHolds.length = 0
    Object.assign(mockState, {fail: null, up: false, connected: false})
  })

  it("holds the fast link until it is closed, and opening twice holds it once", async () => {
    const link = createLink("app fast link")
    await link.openFast()
    await link.openFast()
    expect(mockHolds.map((hold) => hold.consumer)).toEqual(["app fast link"])
    await link.closeFast()
    await link.closeFast()
    expect(mockHolds[0].released).toBe(true)
  })

  it("shows the glasses connection and the fast link, and hears only real changes", () => {
    const link = createLink("app fast link")
    const states: string[] = []
    link.onChange((state) => states.push(`${state.glasses}/${state.fast}`))
    expect(link.state).toEqual({glasses: "disconnected", fast: "down"})
    setGlasses(true)
    setWifi(true)
    setWifi(true)
    setWifi(false)
    setGlasses(false)
    expect(states).toEqual(["connected/down", "connected/up", "connected/down", "disconnected/down"])
  })

  it("gives back a fast link the glasses did not bring back, and a new open asks again", async () => {
    const link = createLink("app fast link")
    await link.openFast()
    await tick()
    mockHolds[0].emit({type: "ended", reason: "glasses did not come back"})
    await tick()
    expect(mockHolds[0].released).toBe(true)
    await link.openFast()
    expect(mockHolds).toHaveLength(2)
  })

  it("rejects when the fast link can't come up, holding nothing", async () => {
    mockState.fail = new Error("The glasses did not enable their hotspot")
    const link = createLink("app fast link")
    await expect(link.openFast()).rejects.toThrow("The glasses did not enable their hotspot")
    mockState.fail = null
    await link.openFast()
    expect(mockHolds).toHaveLength(1)
  })
})
