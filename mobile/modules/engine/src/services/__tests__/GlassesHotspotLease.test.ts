/// <reference types="bun-types" />

import {afterEach, describe, expect, mock, setSystemTime, test} from "bun:test"

import {acquireGlassesHotspot, LATE_ENABLE_WINDOW_MS, reclaimLateHotspot} from "../GlassesHotspotLease"

afterEach(() => setSystemTime())

describe("late hotspot enable (OS-2133)", () => {
  test("turns off an AP that comes up with no owner soon after a release, holding the reservation", async () => {
    setSystemTime(new Date(1_000_000))
    acquireGlassesHotspot()()
    let heldWhileSending = false
    const setHotspotState = mock(async () => {
      heldWhileSending = (() => {
        try {
          acquireGlassesHotspot()()
          return false
        } catch {
          return true
        }
      })()
    })
    setSystemTime(new Date(1_000_000 + LATE_ENABLE_WINDOW_MS - 1))
    expect(await reclaimLateHotspot(setHotspotState)).toBe(true)
    expect(setHotspotState.mock.calls).toEqual([[false]])
    expect(heldWhileSending).toBe(true)
    acquireGlassesHotspot()()
  })

  test("leaves an owned AP alone", async () => {
    const release = acquireGlassesHotspot()
    const setHotspotState = mock(async () => {})
    expect(await reclaimLateHotspot(setHotspotState)).toBe(false)
    expect(setHotspotState).not.toHaveBeenCalled()
    release()
  })

  test("leaves an AP the glasses start long after the last release alone", async () => {
    setSystemTime(new Date(2_000_000))
    acquireGlassesHotspot()()
    setSystemTime(new Date(2_000_000 + LATE_ENABLE_WINDOW_MS))
    const setHotspotState = mock(async () => {})
    expect(await reclaimLateHotspot(setHotspotState)).toBe(false)
    expect(setHotspotState).not.toHaveBeenCalled()
  })

  test("releases the reservation when the disable fails", async () => {
    setSystemTime(new Date(3_000_000))
    acquireGlassesHotspot()()
    await expect(reclaimLateHotspot(async () => Promise.reject(new Error("BLE down")))).rejects.toThrow("BLE down")
    acquireGlassesHotspot()()
  })
})
