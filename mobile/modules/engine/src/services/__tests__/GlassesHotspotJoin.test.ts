/// <reference types="bun-types" />

import {describe, expect, mock, test} from "bun:test"

const intervals = new Map<number, () => void>()
let nextInterval = 0
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setInterval: (callback: () => void) => {
      intervals.set(++nextInterval, callback)
      return nextInterval
    },
    clearInterval: (id: number) => intervals.delete(id),
  },
}))
/** One keep-alive period passing, and the enables it sent answered. */
const tick = async () => {
  intervals.forEach((callback) => callback())
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}
const statusListeners = new Set<(changed: {connection?: {state: string}}) => void>()
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    subscribeGlassesStatus: (listener: (changed: {connection?: {state: string}}) => void) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
  },
}))

const {acquireGlassesHotspot} = await import("../GlassesHotspotLease")
const {keepHotspotUpWhileJoining} = await import("../GlassesHotspotJoin")

describe("keeping the hotspot up during a join", () => {
  function pendingJoin() {
    let finish!: (address: string) => void
    let fail!: (error: Error) => void
    const join = new Promise<string>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    return {join, finish, fail}
  }

  test("re-sends the enable while the join waits, for as long as it waits, and stops once it settles", async () => {
    const release = acquireGlassesHotspot()
    const {join, finish} = pendingJoin()
    const enable = mock(async () => ({state: "enabled"}))
    const cancel = mock(() => {})
    const joined = keepHotspotUpWhileJoining(join, {enable, cancel})
    for (let period = 0; period < 20; period++) await tick()
    expect(enable).toHaveBeenCalledTimes(20)
    finish("192.168.43.2")
    expect(await joined).toBe("192.168.43.2")
    await tick()
    expect(enable).toHaveBeenCalledTimes(20)
    expect(cancel).not.toHaveBeenCalled()
    expect(intervals.size).toBe(0)
    expect(statusListeners.size).toBe(0)
    release()
  })

  test("sends nothing once the AP has another owner", async () => {
    const release = acquireGlassesHotspot()
    const {join, fail} = pendingJoin()
    const enable = mock(async () => ({state: "enabled"}))
    const joined = keepHotspotUpWhileJoining(join, {enable, cancel: () => {}})
    release()
    await tick()
    const next = acquireGlassesHotspot()
    await tick()
    expect(enable).not.toHaveBeenCalled()
    fail(new Error("Hotspot join cancelled"))
    await expect(joined).rejects.toThrow("Hotspot join cancelled")
    next()
  })

  test("ends the join when the glasses answer an enable with the AP off", async () => {
    const release = acquireGlassesHotspot()
    const {join, fail} = pendingJoin()
    const enable = mock(async () => ({state: "disabled"}))
    const cancel = mock(() => fail(new Error("Hotspot join cancelled")))
    const ended = keepHotspotUpWhileJoining(join, {enable, cancel}).catch((error: Error) => error.message)
    await tick()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await ended).toBe("Hotspot join cancelled")
    release()
  })

  test("ends the join when the glasses disconnect, and not on an unanswered enable", async () => {
    const release = acquireGlassesHotspot()
    const {join, fail} = pendingJoin()
    const enable = mock(async () => {
      throw new Error("Timed out waiting for glasses response")
    })
    const cancel = mock(() => fail(new Error("Hotspot join cancelled")))
    const ended = keepHotspotUpWhileJoining(join, {enable, cancel}).catch((error: Error) => error.message)
    await tick()
    statusListeners.forEach((listener) => listener({connection: {state: "connecting"}}))
    expect(cancel).not.toHaveBeenCalled()
    statusListeners.forEach((listener) => listener({connection: {state: "disconnected"}}))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await ended).toBe("Hotspot join cancelled")
    release()
  })
})
