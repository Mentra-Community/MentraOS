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

  it("provides the same Notify owner on iOS without requesting Android capture access", () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    try {
      const apps = (
        builtInMiniappCatalog as unknown as {
          buildOfflineApps: () => Array<{packageName: string; type: string; permissions: unknown[]}>
        }
      ).buildOfflineApps()
      expect(apps.find((app) => app.packageName === notifyPackageName)).toEqual(
        expect.objectContaining({type: "background", permissions: []}),
      )
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
    settingListener(undefined)
    expect(appRegistry.setOfflineAppHidden).toHaveBeenLastCalledWith(miniappDeveloperPackageName, true)
    expect(engine.miniapps.setHiddenStatus).toHaveBeenLastCalledWith(miniappDeveloperPackageName, true)
  })

  it("removes persisted Call menu entries when the iOS opt-in is turned off", async () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    const override = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    const notes = {name: "Notes", packageName: "com.mentra.notes", running: false}
    try {
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, true)
      await engine.settings.set(SETTINGS.menu_apps.key, [
        {name: "Call", packageName: mentraCallPackageName, running: true},
        notes,
      ])
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
      await waitFor(() => expect(engine.settings.get(SETTINGS.menu_apps.key)).toEqual([notes]))
    } finally {
      if (override === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
      else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = override
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
  })

  it.each(["android", "ios"])("keeps permitted saved Call menu entries on %s", async (os) => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: os})
    const override = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    if (os === "ios") process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    else delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    const menu = [{name: "Call", packageName: mentraCallPackageName, running: false}]
    try {
      await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
      await engine.settings.set(SETTINGS.menu_apps.key, menu)
      await (builtInMiniappCatalog as unknown as {syncGlassesMenuApps: () => Promise<void>}).syncGlassesMenuApps()
      expect(engine.settings.get(SETTINGS.menu_apps.key)).toEqual(menu)
    } finally {
      if (override === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
      else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = override
      Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
    }
  })
})
