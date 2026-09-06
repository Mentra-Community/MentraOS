/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

const GATE_KEY = "loudness_gate_enabled"
const MIGRATION_KEY = "migration:loudness_gate_default_off_v1"
const saved = new Map<string, unknown>()
let failGateSave = false
let logSpy: ReturnType<typeof spyOn>

mock.module("react-native-localize", () => ({getTimeZone: () => "UTC"}))
mock.module("./glasses", () => ({useGlassesStore: {getState: () => ({deviceModel: "Mentra Live"})}}))
mock.module("../utils/storage", () => ({
  storage: {
    load: (key: string) => (saved.has(key) ? Res.ok(saved.get(key)) : Res.error(new Error("Missing value"))),
    loadSubKeys: () => Res.ok({}),
    save: (key: string, value: unknown) => {
      if (key === GATE_KEY && failGateSave) return Res.error(new Error("Write failed"))
      saved.set(key, value)
      return Res.ok(undefined)
    },
  },
}))

function restartSettings() {
  delete require.cache[require.resolve("./settings")]
  return require("./settings") as typeof import("./settings")
}

describe("loudness gate settings migration", () => {
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    Object.assign(globalThis, {__DEV__: false})
    saved.clear()
    failGateSave = false
  })

  afterEach(() => logSpy.mockRestore())

  test("fresh installs default off and send off to Mentra Live", async () => {
    const {SETTINGS, useSettingsStore} = restartSettings()
    expect(SETTINGS[GATE_KEY].defaultValue()).toBe(false)
    const result = await useSettingsStore.getState().loadAllSettings()
    expect(result.is_error()).toBe(false)
    expect(useSettingsStore.getState().getBluetoothSettings()[GATE_KEY]).toBe(false)
    expect(saved.get(GATE_KEY)).toBe(false)
    expect(saved.get(MIGRATION_KEY)).toBe(true)
  })

  test("resets a saved true once, then preserves a later opt-in across restart", async () => {
    saved.set(GATE_KEY, true)
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    expect(useSettingsStore.getState().getSetting(GATE_KEY)).toBe(false)
    expect(saved.get(GATE_KEY)).toBe(false)

    await useSettingsStore.getState().setSetting(GATE_KEY, true)
    const restartedStore = restartSettings().useSettingsStore
    await restartedStore.getState().loadAllSettings()
    expect(restartedStore.getState().getBluetoothSettings()[GATE_KEY]).toBe(true)
    expect(saved.get(GATE_KEY)).toBe(true)
  })

  test("retries on the next launch if persisting the reset failed", async () => {
    saved.set(GATE_KEY, true)
    failGateSave = true
    await restartSettings().useSettingsStore.getState().loadAllSettings()
    expect(saved.get(MIGRATION_KEY)).toBeUndefined()
    expect(saved.get(GATE_KEY)).toBe(true)

    failGateSave = false
    await restartSettings().useSettingsStore.getState().loadAllSettings()
    expect(saved.get(GATE_KEY)).toBe(false)
    expect(saved.get(MIGRATION_KEY)).toBe(true)
  })
})
