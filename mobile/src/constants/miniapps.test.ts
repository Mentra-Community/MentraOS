import {mentraCallPackageName, navigationPackageName, shouldHideMiniapp} from "@/constants/miniapps"

describe("shouldHideMiniapp", () => {
  it("hides Mentra Call on iOS and leaves it visible on Android", () => {
    expect(shouldHideMiniapp(mentraCallPackageName, "ios")).toBe(true)
    expect(shouldHideMiniapp(mentraCallPackageName, "android")).toBe(false)
  })

  it("does not hide other bundled miniapps on iOS", () => {
    expect(shouldHideMiniapp(navigationPackageName, "ios")).toBe(false)
    expect(shouldHideMiniapp("com.mentra.notes", "ios")).toBe(false)
  })
})
