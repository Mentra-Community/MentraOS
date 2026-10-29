/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

const VAD_KEY = "voice_activity_detection_enabled"
const MIGRATION_KEY = "migration:vad_default_off_v2"
const V1_MIGRATION_KEY = "migration:vad_default_off_v1"
const saved = new Map<string, unknown>()
let failVadSave = false
let logSpy: ReturnType<typeof spyOn>

mock.module("react-native-localize", () => ({getTimeZone: () => "UTC"}))
mock.module("../glasses", () => ({useGlassesStore: {getState: () => ({deviceModel: "Mentra Live"})}}))
mock.module("../../utils/storage", () => ({
  storage: {
    load: (key: string) => (saved.has(key) ? Res.ok(saved.get(key)) : Res.error(new Error("Missing value"))),
    loadSubKeys: () => Res.ok({}),
    save: (key: string, value: unknown) => {
      if (key === VAD_KEY && failVadSave) return Res.error(new Error("Write failed"))
      saved.set(key, value)
      return Res.ok(undefined)
    },
  },
}))

function restartSettings() {
  delete require.cache[require.resolve("../settings")]
  return require("../settings") as typeof import("../settings")
}

describe("voice activity detection settings migration", () => {
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    Object.assign(globalThis, {__DEV__: false})
    saved.clear()
    failVadSave = false
  })

  afterEach(() => logSpy.mockRestore())

  test("fresh installs default off and send off to Mentra Live", async () => {
    const {SETTINGS, useSettingsStore} = restartSettings()
    expect(SETTINGS[VAD_KEY].defaultValue()).toBe(false)
    const result = await useSettingsStore.getState().loadAllSettings()
    expect(result.is_error()).toBe(false)
    expect(useSettingsStore.getState().getBluetoothSettings()[VAD_KEY]).toBe(false)
    expect(saved.get(MIGRATION_KEY)).toBe(true)
  })

  test.each([
    ["saved on under the old default", {}],
    ["turned back on after the v1 migration", {[V1_MIGRATION_KEY]: true}],
  ])("turns VAD off once for an install %s, then preserves a later opt-in", async (_label, markers) => {
    saved.set(VAD_KEY, true)
    for (const [key, value] of Object.entries(markers)) saved.set(key, value)
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    expect(useSettingsStore.getState().getBluetoothSettings()[VAD_KEY]).toBe(false)
    expect(saved.get(VAD_KEY)).toBe(false)
    expect(saved.get(MIGRATION_KEY)).toBe(true)

    await useSettingsStore.getState().setSetting(VAD_KEY, true)
    const restartedStore = restartSettings().useSettingsStore
    await restartedStore.getState().loadAllSettings()
    expect(restartedStore.getState().getBluetoothSettings()[VAD_KEY]).toBe(true)
    expect(saved.get(VAD_KEY)).toBe(true)
  })

  test("retries on the next launch if persisting the change failed", async () => {
    saved.set(VAD_KEY, true)
    failVadSave = true
    await restartSettings().useSettingsStore.getState().loadAllSettings()
    expect(saved.get(MIGRATION_KEY)).toBeUndefined()
    expect(saved.get(VAD_KEY)).toBe(true)

    failVadSave = false
    await restartSettings().useSettingsStore.getState().loadAllSettings()
    expect(saved.get(VAD_KEY)).toBe(false)
    expect(saved.get(MIGRATION_KEY)).toBe(true)
  })
})
