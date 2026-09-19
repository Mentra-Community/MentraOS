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

  it("hides both miniapps on iOS by default", () => {
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(notifyPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(navigationPackageName, "ios")).toBe(false)
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("honors independent opt-ins: Call=%s, Notify=%s", (showIosCall, showIosNotify) => {
    const optIns = {showIosCall, showIosNotify}
    expect(shouldHideMiniapp(mentraCallPackageName, "ios", optIns)).toBe(!showIosCall)
    expect(shouldHideMiniapp(notifyPackageName, "ios", optIns)).toBe(!showIosNotify)
    expect(shouldHideMiniapp(mentraCallPackageName, "android", optIns)).toBe(false)
    expect(shouldHideMiniapp(notifyPackageName, "android", optIns)).toBe(false)
  })

  it.each(["ios", "android"] as const)("retains China restrictions on %s despite opt-ins", (os) => {
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    const optIns = {showIosCall: true, showIosNotify: true}
    expect(shouldHideMiniapp(navigationPackageName, os, optIns)).toBe(true)
    expect(shouldHideMiniapp(notifyPackageName, os, optIns)).toBe(true)
    expect(shouldHideMiniapp(mentraCallPackageName, os, optIns)).toBe(false)
    expect(shouldHideMiniapp("com.mentra.notes", os, optIns)).toBe(false)
  })
  it.each([undefined, "", "false", "TRUE", "true"])("limits build override %s to Call", (override) => {
    if (override === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = override
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(override !== "true")
    expect(shouldHideMiniapp(notifyPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(notifyPackageName, "ios", {showIosNotify: true})).toBe(false)
  })
})
