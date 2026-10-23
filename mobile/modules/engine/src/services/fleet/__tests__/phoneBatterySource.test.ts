/// <reference types="bun-types" />

import {beforeEach, describe, expect, spyOn, test} from "bun:test"

import {createPhoneBatterySource, type PhoneBatteryPlatform} from "../phoneBatterySource"

/** expo-battery's battery states. */
const UNKNOWN = 0
const UNPLUGGED = 1
const CHARGING = 2
const FULL = 3

let available: boolean
let power: {batteryLevel: number; batteryState: number; lowPowerMode: boolean}
let reads: number
let pending: Array<() => void>

const platform: PhoneBatteryPlatform = {
  isAvailableAsync: async () => available,
  getPowerStateAsync: () => {
    reads += 1
    return new Promise((resolve) => pending.push(() => resolve({...power})))
  },
}

/** Lets every read started so far answer, then lets the source take the answers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (const answer of pending.splice(0)) answer()
    await Promise.resolve()
  }
}

beforeEach(() => {
  available = true
  power = {batteryLevel: 0.637, batteryState: UNPLUGGED, lowPowerMode: true}
  reads = 0
  pending = []
})

describe("the phone battery source", () => {
  test("knows nothing before its first reading", () => {
    expect(createPhoneBatterySource(platform).read()).toBeNull()
  })

  test("reads the level as a whole percent, and only the level and whether it is charging", async () => {
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await settle()
    expect(source.read()).toEqual({level: 64, charging: false})
  })

  test.each([
    [CHARGING, true],
    [FULL, true],
    [UNPLUGGED, false],
    [UNKNOWN, false],
  ])("battery state %d is charging: %p", async (batteryState, charging) => {
    power.batteryState = batteryState
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await settle()
    expect(source.read()).toMatchObject({charging})
  })

  test("an empty battery is a level of 0", async () => {
    power.batteryLevel = 0
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await settle()
    expect(source.read()).toEqual({level: 0, charging: false})
  })

  test.each([-1, Number.NaN, 1.5])("a level of %p is no reading", async (batteryLevel) => {
    power.batteryLevel = batteryLevel
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await settle()
    expect(source.read()).toBeNull()
  })

  test("a phone whose battery API is not available is unsupported, and is not read again", async () => {
    available = false
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await settle()
    expect(source.read()).toBe("unsupported")
    source.refresh()
    await settle()
    expect(reads).toBe(0)
  })

  test("tells its listeners when the reading changed, and only then", async () => {
    const source = createPhoneBatterySource(platform)
    let heard = 0
    const stop = source.subscribe(() => (heard += 1))
    source.refresh()
    await settle()
    expect(heard).toBe(1)
    source.refresh()
    await settle()
    expect(heard).toBe(1)
    power.batteryLevel = 0.5
    source.refresh()
    await settle()
    expect(heard).toBe(2)
    stop()
    power.batteryLevel = 0.4
    source.refresh()
    await settle()
    expect(heard).toBe(2)
  })

  test("a refresh while one is reading is the same read", async () => {
    const source = createPhoneBatterySource(platform)
    source.refresh()
    await Promise.resolve()
    source.refresh()
    source.refresh()
    await settle()
    expect(reads).toBe(1)
    source.refresh()
    await settle()
    expect(reads).toBe(2)
  })

  test("a failed read keeps the last reading and does not throw", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      let fail = false
      const source = createPhoneBatterySource({
        isAvailableAsync: async () => true,
        getPowerStateAsync: async () => {
          if (fail) throw new Error("native read failed")
          return {...power}
        },
      })
      source.refresh()
      await settle()
      fail = true
      expect(() => source.refresh()).not.toThrow()
      await settle()
      expect(source.read()).toEqual({level: 64, charging: false})
      // A failed read does not hold back the next one.
      fail = false
      power.batteryLevel = 0.2
      source.refresh()
      await settle()
      expect(source.read()).toEqual({level: 20, charging: false})
    } finally {
      warn.mockRestore()
    }
  })

  test("a platform that cannot even be loaded is no reading, and does not throw", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const source = createPhoneBatterySource(() => {
        throw new Error("no native module")
      })
      expect(() => source.refresh()).not.toThrow()
      await settle()
      expect(source.read()).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })
})
