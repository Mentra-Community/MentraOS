import {getNextOnboardingRoute} from "./getNextOnboardingRoute"

describe("getNextOnboardingRoute", () => {
  it("prioritizes Mentra Live onboarding after OTA", () => {
    expect(
      getNextOnboardingRoute({
        includeMentraLive: true,
        onboardingLiveCompleted: false,
        onboardingOsCompleted: false,
      }),
    ).toBe("/onboarding/live")
  })

  it("continues from completed Mentra Live onboarding into MentraOS onboarding", () => {
    expect(
      getNextOnboardingRoute({
        includeMentraLive: true,
        onboardingLiveCompleted: true,
        onboardingOsCompleted: false,
      }),
    ).toBe("/onboarding/os")
  })

  it("continues into MentraOS onboarding when leaving Mentra Live onboarding", () => {
    expect(
      getNextOnboardingRoute({
        includeMentraLive: false,
        onboardingLiveCompleted: false,
        onboardingOsCompleted: false,
      }),
    ).toBe("/onboarding/os")
  })

  it("finishes when all applicable onboarding is complete", () => {
    expect(
      getNextOnboardingRoute({
        includeMentraLive: true,
        onboardingLiveCompleted: true,
        onboardingOsCompleted: true,
      }),
    ).toBeNull()
  })
})
