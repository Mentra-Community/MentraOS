import * as Engine from "@mentra/engine"
import {act, renderHook} from "@testing-library/react-native"
import {Platform} from "react-native"

import {useAvailableApps} from "./useAppsExtras"

describe("available miniapps for home and All Apps", () => {
  beforeEach(async () => {
    jest.replaceProperty(Platform, "OS", "ios")
    jest.spyOn(Engine, "useApps").mockReturnValue([
      {packageName: "com.mentra.call", hidden: false},
      {packageName: "cloud.augmentos.notify", hidden: false},
      {packageName: "com.mentra.notes", hidden: true},
    ] as Engine.ClientApp[])
    await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, false)
    await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, false)
  })
  afterEach(() => jest.restoreAllMocks())

  it("filters cached entries independently and preserves user-hidden apps for All Apps", async () => {
    const {result} = renderHook(useAvailableApps)
    const packages = () => result.current.map((app) => app.packageName)
    expect(packages()).toEqual(["com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, true)
    })
    expect(packages()).toEqual(["cloud.augmentos.notify", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, true)
    })
    expect(packages()).toEqual(["com.mentra.call", "cloud.augmentos.notify", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, false)
    })
    expect(packages()).toEqual(["com.mentra.call", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_mentra_call_ios.key, false)
    })
    expect(packages()).toEqual(["com.mentra.notes"])
  })

  it("keeps Android unchanged", () => {
    jest.replaceProperty(Platform, "OS", "android")
    expect(renderHook(useAvailableApps).result.current).toHaveLength(3)
  })
})
