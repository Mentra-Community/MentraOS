/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

const DESIRED_KEY = "mic_tuning_desired"
const EFFECTIVE_KEY = "mic_tuning"
const SUPER_KEY = "super_mode"
const saved = new Map<string, unknown>()
let logSpy: ReturnType<typeof spyOn>

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

const TUNING = {gain: 12, open: 2000, hang: 120}

describe("mic tuning effective value", () => {
  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {})
    Object.assign(globalThis, {__DEV__: false})
    saved.clear()
  })

  afterEach(() => logSpy.mockRestore())

  test("a fresh install sends an empty tuning, which the glasses read as reset", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    expect(useSettingsStore.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual({})
  })

  test("only the effective key is synced to the glasses", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    const bluetooth = useSettingsStore.getState().getBluetoothSettings()
    expect(Object.keys(bluetooth)).toContain(EFFECTIVE_KEY)
    expect(Object.keys(bluetooth)).not.toContain(DESIRED_KEY)
  })

  test("super mode on publishes the desired tuning", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    await useSettingsStore.getState().setSetting(SUPER_KEY, true)
    await useSettingsStore.getState().setSetting(DESIRED_KEY, TUNING)

    expect(useSettingsStore.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual(TUNING)
  })

  test("turning super mode off publishes a reset but keeps the calibration", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    await useSettingsStore.getState().setSetting(SUPER_KEY, true)
    await useSettingsStore.getState().setSetting(DESIRED_KEY, TUNING)
    await useSettingsStore.getState().setSetting(SUPER_KEY, false)

    expect(useSettingsStore.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual({})
    // Retained, so re-enabling super mode does not lose the wearer's work.
    expect(useSettingsStore.getState().getSetting(DESIRED_KEY)).toEqual(TUNING)

    await useSettingsStore.getState().setSetting(SUPER_KEY, true)
    expect(useSettingsStore.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual(TUNING)
  })

  test("non-numeric fields are dropped rather than forwarded to the firmware", async () => {
    const {useSettingsStore} = restartSettings()
    await useSettingsStore.getState().loadAllSettings()
    await useSettingsStore.getState().setSetting(SUPER_KEY, true)
    await useSettingsStore.getState().setSetting(DESIRED_KEY, {
      open: 1800,
      close: "nope",
      hang: Number.NaN,
      attack: 4.6,
    })

    expect(useSettingsStore.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual({open: 1800, attack: 5})
  })

  test("the desired tuning is never persisted to the server", async () => {
    const {SETTINGS} = restartSettings()
    expect(SETTINGS[DESIRED_KEY].saveOnServer).toBe(false)
    expect(SETTINGS[DESIRED_KEY].persist).toBe(true)
    // The effective value is recomputed each launch, never restored from disk.
    expect(SETTINGS[EFFECTIVE_KEY].persist).toBe(false)
    expect(SETTINGS[EFFECTIVE_KEY].saveOnServer).toBe(false)
  })

  /*
   * The regression this whole desired/effective split exists for. A tuning set
   * while super mode was on must not reach the glasses after the user turns
   * super mode off and relaunches, no matter how the startup order falls out.
   */
  test("a persisted tuning never leaves the phone after super mode is disabled and the app restarts", async () => {
    const first = restartSettings().useSettingsStore
    await first.getState().loadAllSettings()
    await first.getState().setSetting(SUPER_KEY, true)
    await first.getState().setSetting(DESIRED_KEY, TUNING)
    expect(first.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual(TUNING)
    await first.getState().setSetting(SUPER_KEY, false)

    // Kill and relaunch: disk still holds the calibration.
    expect(saved.get(DESIRED_KEY)).toEqual(TUNING)
    const relaunched = restartSettings().useSettingsStore

    // Before load, and after it, the glasses-bound value stays empty.
    expect(relaunched.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual({})
    await relaunched.getState().loadAllSettings()
    expect(relaunched.getState().getBluetoothSettings()[EFFECTIVE_KEY]).toEqual({})
    expect(relaunched.getState().getSetting(DESIRED_KEY)).toEqual(TUNING)
  })
})
