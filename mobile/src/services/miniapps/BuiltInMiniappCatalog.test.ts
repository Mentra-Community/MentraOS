import {Platform} from "react-native"

import {appRegistry} from "@mentra/engine-host-internal"

import {miniappDeveloperPackageName, notifyPackageName} from "@/constants/miniapps"
import {SETTINGS, engine} from "@mentra/engine"

import builtInMiniappCatalog from "./BuiltInMiniappCatalog"

describe("BuiltInMiniappCatalog", () => {
  const originalPlatform = Platform.OS

  beforeAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
  })

  afterAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
  })

  it("registers Notifications as a permission-gated background miniapp", () => {
    builtInMiniappCatalog.init()

    const notifyCall = (appRegistry.installOfflineApp as jest.Mock).mock.calls.find(
      ([app]) => app.packageName === notifyPackageName,
    )

    expect(notifyCall?.[0]).toEqual(
      expect.objectContaining({
        packageName: notifyPackageName,
        type: "background",
        permissions: [{type: "READ_NOTIFICATIONS", required: true}],
      }),
    )
  })

  it("registers the Miniapp Developer launcher hidden by default and follows its home-screen setting", () => {
    const developerCall = (appRegistry.installOfflineApp as jest.Mock).mock.calls.find(
      ([app]) => app.packageName === miniappDeveloperPackageName,
    )

    expect(developerCall?.[0]).toEqual(
      expect.objectContaining({
        packageName: miniappDeveloperPackageName,
        offlineRoute: "/miniapps/settings/miniapp-dev",
        hidden: true,
      }),
    )
    expect(engine.miniapps.setHiddenStatus).toHaveBeenCalledWith(miniappDeveloperPackageName, true)

    const settingListener = (engine.settings.onChanged as jest.Mock).mock.calls.find(
      ([key]) => key === SETTINGS.miniapp_dev_mode.key,
    )?.[1]

    expect(settingListener).toEqual(expect.any(Function))
    settingListener(true)
    expect(appRegistry.setOfflineAppHidden).toHaveBeenLastCalledWith(miniappDeveloperPackageName, false)
    expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(miniappDeveloperPackageName, false)
    settingListener(false)
    expect(appRegistry.setOfflineAppHidden).toHaveBeenLastCalledWith(miniappDeveloperPackageName, true)
    expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(miniappDeveloperPackageName, true)
  })
})
