import {Platform} from "react-native"
import {SETTINGS, engine} from "@mentra/engine"
import {mentraCallPackageName} from "@/constants/miniapps"
import {shouldHideMiniapp} from "./miniappVisibility"

describe("live Call visibility policy", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "ios")
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  })
  afterEach(() => {
    jest.restoreAllMocks()
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })

  it("reads current local settings and restores them when a build override is removed", async () => {
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, true)
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(true)
  })

  it("keeps the opt-in local, persistent, and off by default", () => {
    const descriptor = engine.settings.descriptor(SETTINGS.show_mentra_call_ios.key)
    expect(descriptor).toMatchObject({saveOnServer: false, persist: true})
    expect(descriptor.defaultValue()).toBe(false)
  })
})
