/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

const AUTO_POWER_OFF_KEY = "auto_power_off_enabled"
const saved = new Map<string, unknown>()

mock.module("react-native-localize", () => ({getTimeZone: () => "UTC"}))
mock.module("../glasses", () => ({useGlassesStore: {getState: () => ({deviceModel: "Mentra Live"})}}))
mock.module("../../utils/storage", () => ({
  storage: {
    load: (key: string) => (saved.has(key) ? Res.ok(saved.get(key)) : Res.error(new Error("Missing value"))),
    loadSubKeys: () => Res.ok({}),
    save: (key: string, value: unknown) => {
      saved.set(key, value)
      return Res.ok(undefined)
    },
  },
}))

function restartSettings() {
  delete require.cache[require.resolve("../settings")]
  return require("../settings") as typeof import("../settings")
}

describe("auto power-off setting", () => {
  beforeEach(() => {
    Object.assign(globalThis, {__DEV__: false})
    saved.clear()
  })

  test("defaults off so a new install does not power the glasses down", async () => {
    const {SETTINGS, useSettingsStore} = restartSettings()
    expect(SETTINGS[AUTO_POWER_OFF_KEY].defaultValue()).toBe(false)

    const result = await useSettingsStore.getState().loadAllSettings()
    expect(result.is_error()).toBe(false)
    expect(useSettingsStore.getState().getBluetoothSettings()[AUTO_POWER_OFF_KEY]).toBe(false)
  })

  test("is synced to the glasses rather than kept app-side", async () => {
    const {SETTINGS, useSettingsStore} = restartSettings()
    expect(SETTINGS[AUTO_POWER_OFF_KEY].persist).toBe(true)
    await useSettingsStore.getState().loadAllSettings()
    expect(AUTO_POWER_OFF_KEY in useSettingsStore.getState().getBluetoothSettings()).toBe(true)
  })

  test("an opt-in survives a restart instead of snapping back to the default", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    await useSettingsStore.getState().setSetting(AUTO_POWER_OFF_KEY, true)
    expect(saved.get(AUTO_POWER_OFF_KEY)).toBe(true)

    const restarted = restartSettings().useSettingsStore
    await restarted.getState().loadAllSettings()
    expect(restarted.getState().getBluetoothSettings()[AUTO_POWER_OFF_KEY]).toBe(true)
  })
})
