import * as Engine from "@mentra/engine"
import {act, renderHook} from "@testing-library/react-native"
import {Platform} from "react-native"

import {useAvailableApps} from "./useAppsExtras"
import {linkLingoPackageName} from "@/constants/miniapps"

describe("available miniapps for home and All Apps", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    jest.replaceProperty(Platform, "OS", "ios")
    jest.spyOn(Engine, "useApps").mockReturnValue([
      {packageName: "com.mentra.call", hidden: false},
      {packageName: "cloud.augmentos.notify", hidden: false},
      {packageName: "com.mentra.notes", hidden: true},
    ] as Engine.ClientApp[])
    await Engine.engine.settings.set("show_mentra_call_ios", false)
    await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, false)
  })
  afterEach(() => jest.restoreAllMocks())

  it.each(["ios", "android"] as const)(
    "reacts to Super Mode changes for cached LinkLingo entries on %s",
    async (os) => {
      jest.replaceProperty(Platform, "OS", os)
      jest.spyOn(Engine, "useApps").mockReturnValue([
        {packageName: linkLingoPackageName, version: "1.0.18", hidden: false},
        {packageName: "com.mentra.notes", hidden: false},
      ] as Engine.ClientApp[])
      await Engine.engine.settings.set(Engine.SETTINGS.super_mode.key, false)
      const {result} = renderHook(useAvailableApps)
      const packages = () => result.current.map((app) => app.packageName)
      try {
        expect(packages()).toEqual(["com.mentra.notes"])
        await act(async () => {
          await Engine.engine.settings.set(Engine.SETTINGS.super_mode.key, true)
        })
        expect(packages()).toEqual([linkLingoPackageName, "com.mentra.notes"])
        await act(async () => {
          await Engine.engine.settings.set(Engine.SETTINGS.super_mode.key, false)
        })
        expect(packages()).toEqual(["com.mentra.notes"])
        await act(async () => {
          await Engine.engine.settings.set(Engine.SETTINGS.super_mode.key, false)
        })
        expect(packages()).toEqual(["com.mentra.notes"])
      } finally {
        await act(async () => {
          await Engine.engine.settings.set(Engine.SETTINGS.super_mode.key, false)
        })
      }
    },
  )

  it("filters cached entries independently and preserves user-hidden apps for All Apps", async () => {
    const {result} = renderHook(useAvailableApps)
    const packages = () => result.current.map((app) => app.packageName)
    expect(packages()).toEqual(["com.mentra.call", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, true)
    })
    expect(packages()).toEqual(["com.mentra.call", "cloud.augmentos.notify", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set("show_mentra_call_ios", true)
    })
    expect(packages()).toEqual(["com.mentra.call", "cloud.augmentos.notify", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set(Engine.SETTINGS.show_notify_ios.key, false)
    })
    expect(packages()).toEqual(["com.mentra.call", "com.mentra.notes"])
    await act(async () => {
      await Engine.engine.settings.set("show_mentra_call_ios", false)
    })
    expect(packages()).toEqual(["com.mentra.call", "com.mentra.notes"])
  })

  it("keeps Android unchanged", () => {
    jest.replaceProperty(Platform, "OS", "android")
    expect(renderHook(useAvailableApps).result.current).toHaveLength(3)
  })
  it("keeps Call visible despite obsolete build overrides", () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    const {result} = renderHook(useAvailableApps)
    expect(result.current.map((app) => app.packageName)).toEqual(["com.mentra.call", "com.mentra.notes"])
  })
})
