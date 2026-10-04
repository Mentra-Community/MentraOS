import {appOrientation} from "./appOrientation"

describe("App-wide landscape opt-in", () => {
  it("keeps tablets portrait with the setting off", () => {
    expect(appOrientation("android", false, 800, 1280)).toBe("portrait")
  })
  it("allows the sensor to choose either orientation without changing policy", () => {
    expect(appOrientation("android", true, 800, 1280)).toBe("all")
    expect(appOrientation("android", true, 1280, 800)).toBe("all")
  })
  it("restores portrait for phones and folded screens", () => {
    expect(appOrientation("android", true, 390, 844)).toBe("portrait")
    expect(appOrientation("android", true, 844, 390)).toBe("portrait")
  })
  it("does not request unsupported iOS orientation", () => {
    expect(appOrientation("ios", true, 800, 1280)).toBe("portrait")
  })
})
