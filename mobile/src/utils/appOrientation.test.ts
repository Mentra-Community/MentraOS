import {appOrientation} from "./appOrientation"

describe.each(["android", "ios"])("App-wide landscape on %s", (platform) => {
  it("enables landscape starting at a shortest edge of 600", () => {
    expect(appOrientation(platform, 600, 960)).toBe("all")
    expect(appOrientation(platform, 960, 600)).toBe("all")
    expect(appOrientation(platform, 599, 960)).toBe("portrait")
  })
  it("allows the sensor to choose either orientation without changing policy", () => {
    expect(appOrientation(platform, 800, 1280)).toBe("all")
    expect(appOrientation(platform, 1280, 800)).toBe("all")
  })
  it("restores portrait for phones and folded screens", () => {
    expect(appOrientation(platform, 390, 844)).toBe("portrait")
    expect(appOrientation(platform, 844, 390)).toBe("portrait")
  })
})
