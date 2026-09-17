import {mentraCallPackageName, navigationPackageName, shouldHideMiniapp} from "@/constants/miniapps"

describe("shouldHideMiniapp", () => {
  const originalRegion = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  afterEach(() => {
    if (originalRegion === undefined) delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    else process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = originalRegion
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })

  it.each([undefined, "", "false", "TRUE", "1", "true"])("uses exact optional override %s only on iOS", (override) => {
    delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    if (override === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = override
    expect(shouldHideMiniapp(mentraCallPackageName, "ios", false)).toBe(override !== "true")
    expect(shouldHideMiniapp(mentraCallPackageName, "ios", true)).toBe(false)
    expect(shouldHideMiniapp(mentraCallPackageName, "android", false)).toBe(false)
    expect(shouldHideMiniapp(mentraCallPackageName, "android", true)).toBe(false)
    expect(shouldHideMiniapp(navigationPackageName, "ios")).toBe(false)
  })

  it("retains the China distribution restrictions", () => {
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    expect(shouldHideMiniapp(navigationPackageName, "ios", true)).toBe(true)
    expect(shouldHideMiniapp(navigationPackageName, "android", true)).toBe(true)
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(false)
    expect(shouldHideMiniapp("com.mentra.notes")).toBe(false)
  })
})
