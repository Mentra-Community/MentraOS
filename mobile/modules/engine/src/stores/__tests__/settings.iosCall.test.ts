/// <reference types="bun-types" />
import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

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
let logSpy: ReturnType<typeof spyOn>
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {})
  Object.assign(globalThis, {__DEV__: true})
  saved.clear()
})
afterEach(() => logSpy.mockRestore())
describe("iOS Call local setting hydration", () => {
  test("defaults off even in development and preserves explicit choices across restarts", async () => {
    const key = "show_mentra_call_ios"
    let state = restartSettings().useSettingsStore
    await state.getState().loadAllSettings()
    expect(state.getState().getSetting(key)).toBe(false)
    await state.getState().setSetting(key, true)
    expect(saved.get(key)).toBe(true)
    state = restartSettings().useSettingsStore
    await state.getState().loadAllSettings()
    expect(state.getState().getSetting(key)).toBe(true)
    await state.getState().setSetting(key, false)
    state = restartSettings().useSettingsStore
    await state.getState().loadAllSettings()
    expect(state.getState().getSetting(key)).toBe(false)
  })
})
