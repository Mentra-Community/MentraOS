import {mentraCallPackageName, navigationPackageName, notifyPackageName, shouldHideMiniapp} from "@/constants/miniapps"

describe("shouldHideMiniapp", () => {
  const originalRegion = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  })
  afterEach(() => {
    if (originalRegion === undefined) delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    else process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = originalRegion
  })

  it("shows Call and hides Notify on iOS by default", () => {
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(navigationPackageName, "ios")).toBe(false)
  })

  it.each([false, true])("keeps Call available with Notify opt-in=%s", (showIosNotify) => {
    const optIns = {showIosNotify}
    expect(shouldHideMiniapp(mentraCallPackageName, "ios", optIns)).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName, "ios", optIns)).toBe(!showIosNotify)
    expect(shouldHideMiniapp(mentraCallPackageName, "android", optIns)).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName, "android", optIns)).toBe(false)
  })

  it.each(["ios", "android"] as const)("retains China restrictions on %s despite opt-ins", (os) => {
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    const optIns = {showIosNotify: true}
    expect(shouldHideMiniapp(navigationPackageName, os, optIns)).toBe(true)
    expect(shouldHideMiniapp(notifyPackageName, os, optIns)).toBe(true)
    expect(shouldHideMiniapp(mentraCallPackageName, os, optIns)).toBe(false)
    expect(shouldHideMiniapp("com.mentra.notes", os, optIns)).toBe(false)
  })
  it.each([undefined, "", "false", "TRUE", "true"])("ignores obsolete Call build override %s", (override) => {
    if (override === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = override
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(notifyPackageName, "ios", {showIosNotify: true})).toBe(false)
  })
})
