import {mentraCallPackageName, navigationPackageName, shouldHideMiniapp} from "@/constants/miniapps"

describe("shouldHideMiniapp", () => {
  const originalRegion = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  afterEach(() => {
    if (originalRegion === undefined) delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    else process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = originalRegion
  })

  it("makes Call available without a platform exclusion", () => {
    delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    expect(shouldHideMiniapp(navigationPackageName)).toBe(false)
  })

  it("retains the China distribution restrictions", () => {
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    expect(shouldHideMiniapp(navigationPackageName)).toBe(true)
    expect(shouldHideMiniapp(mentraCallPackageName)).toBe(false)
    expect(shouldHideMiniapp("com.mentra.notes")).toBe(false)
  })
})
