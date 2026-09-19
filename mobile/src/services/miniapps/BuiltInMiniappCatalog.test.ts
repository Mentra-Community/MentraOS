import {waitFor} from "@testing-library/react-native"
import {Platform} from "react-native"

import {appRegistry} from "@mentra/engine-host-internal"

import {mentraCallPackageName, miniappDeveloperPackageName, notifyPackageName} from "@/constants/miniapps"
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

  it("registers Notify on iOS only after opt-in, without Android capture access or duplicate registrations", async () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    try {
      const catalog = new (builtInMiniappCatalog.constructor as new () => {
        buildOfflineApps: () => Array<{packageName: string; type: string; permissions: unknown[]}>
        installNotify: () => void
      })()
      await engine.settings.set(SETTINGS.show_notify_ios.key, false)
      expect(catalog.buildOfflineApps().find((app) => app.packageName === notifyPackageName)).toBeUndefined()
      const installed = (appRegistry.installOfflineApp as jest.Mock).mock.calls.length
      catalog.installNotify()
      expect(appRegistry.installOfflineApp).toHaveBeenCalledTimes(installed)
      await engine.settings.set(SETTINGS.show_notify_ios.key, true)
      catalog.installNotify()
      expect(appRegistry.installOfflineApp).toHaveBeenLastCalledWith(
        expect.objectContaining({packageName: notifyPackageName, type: "background", permissions: []}),
      )
      await engine.settings.set(SETTINGS.show_notify_ios.key, false)
      await engine.settings.set(SETTINGS.show_notify_ios.key, true)
      catalog.installNotify()
      expect(appRegistry.installOfflineApp).toHaveBeenCalledTimes(installed + 1)
      await engine.settings.set(SETTINGS.show_notify_ios.key, false)
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
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

  it.each([
    [mentraCallPackageName, SETTINGS.show_mentra_call_ios.key],
    [notifyPackageName, SETTINGS.show_notify_ios.key],
  ])("removes saved %s menu entries when its iOS opt-in is turned off", async (packageName, key) => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    const notes = {name: "Notes", packageName: "com.mentra.notes", running: false}
    try {
      await engine.settings.set(key, true)
      await engine.settings.set(SETTINGS.menu_apps.key, [{name: "Experimental", packageName, running: true}, notes])
      await engine.settings.set(key, false)
      await waitFor(() => expect(engine.settings.get(SETTINGS.menu_apps.key)).toEqual([notes]))
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
  })

  it.each(["android", "ios"])("keeps permitted saved menu entries on %s", async (os) => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: os})
    const menu = [
      {name: "Call", packageName: mentraCallPackageName, running: false},
      {name: "Notify", packageName: notifyPackageName, running: false},
    ]
    try {
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, os === "ios")
      await engine.settings.set(SETTINGS.show_notify_ios.key, os === "ios")
      await engine.settings.set(SETTINGS.menu_apps.key, menu)
      await (builtInMiniappCatalog as unknown as {syncGlassesMenuApps: () => Promise<void>}).syncGlassesMenuApps()
      expect(engine.settings.get(SETTINGS.menu_apps.key)).toEqual(menu)
    } finally {
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
  })
})
