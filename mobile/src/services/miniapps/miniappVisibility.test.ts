import {Platform} from "react-native"
import {SETTINGS, engine} from "@mentra/engine"
import {mentraCallPackageName, notifyPackageName} from "@/constants/miniapps"
import {shouldHideMiniapp} from "./miniappVisibility"

describe("live iOS miniapp visibility policy", () => {
  beforeEach(async () => {
    jest.replaceProperty(Platform, "OS", "ios")
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
    await engine.settings.set(SETTINGS.show_notify_ios.key, false)
  })
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [mentraCallPackageName, SETTINGS.show_mentra_call_ios.key, notifyPackageName],
    [notifyPackageName, SETTINGS.show_notify_ios.key, mentraCallPackageName],
  ])("reads the current local setting for %s without enabling the other miniapp", async (pkg, key, other) => {
    expect(shouldHideMiniapp(pkg)).toBe(true)
    await engine.settings.set(key, true)
    expect(shouldHideMiniapp(pkg)).toBe(false)
    expect(shouldHideMiniapp(other)).toBe(true)
    await engine.settings.set(key, false)
    expect(shouldHideMiniapp(pkg)).toBe(true)
  })

  it.each([SETTINGS.show_mentra_call_ios.key, SETTINGS.show_notify_ios.key])(
    "keeps %s local, persistent, and off by default",
    (key) => {
      const descriptor = engine.settings.descriptor(key)
      expect(descriptor).toMatchObject({saveOnServer: false, persist: true})
      expect(descriptor.defaultValue()).toBe(false)
    },
  )
})
