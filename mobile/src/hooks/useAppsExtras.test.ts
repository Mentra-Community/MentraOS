import * as Engine from "@mentra/engine"
import {act, renderHook} from "@testing-library/react-native"
import {Platform} from "react-native"

import {useAvailableApps} from "./useAppsExtras"

describe("available miniapps for home, All Apps, and glasses menu", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  beforeEach(async () => {
    jest.replaceProperty(Platform, "OS", "ios")
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    jest.spyOn(Engine, "useApps").mockReturnValue([
      {packageName: "com.mentra.call", hidden: false},
      {packageName: "cloud.augmentos.notify", hidden: false},
      {packageName: "com.mentra.notes", hidden: true},
    ] as Engine.ClientApp[])
    await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, false)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  it("filters cached iOS-restricted entries even when Call is enabled or All Apps shows hidden apps", async () => {
    const {result} = renderHook(useAvailableApps)
    expect(result.current.map((app) => app.packageName)).toEqual(["com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, true)
    })
    expect(result.current.map((app) => app.packageName)).toEqual(["com.mentra.call", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, false)
    })
    expect(result.current.map((app) => app.packageName)).toEqual(["com.mentra.notes"])
  })
  it("permits the build override and keeps Android unchanged", () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    expect(renderHook(useAvailableApps).result.current.map((app) => app.packageName)).toEqual([
      "com.mentra.call",
      "com.mentra.notes",
    ])
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    jest.replaceProperty(Platform, "OS", "android")
    expect(renderHook(useAvailableApps).result.current.map((app) => app.packageName)).toEqual([
      "com.mentra.call",
      "cloud.augmentos.notify",
      "com.mentra.notes",
    ])
  })
})
