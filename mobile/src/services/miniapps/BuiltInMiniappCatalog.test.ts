import {Platform} from "react-native"

import {appRegistry} from "@mentra/engine/internal"

import {notifyPackageName} from "@/constants/miniapps"

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
})
