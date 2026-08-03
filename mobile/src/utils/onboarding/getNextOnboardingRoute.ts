export type OnboardingRoute = "/onboarding/live" | "/onboarding/os"

interface GetNextOnboardingRouteOptions {
  includeMentraLive: boolean
  onboardingLiveCompleted: boolean
  onboardingOsCompleted: boolean
}

export function getNextOnboardingRoute({
  includeMentraLive,
  onboardingLiveCompleted,
  onboardingOsCompleted,
}: GetNextOnboardingRouteOptions): OnboardingRoute | null {
  if (includeMentraLive && !onboardingLiveCompleted) {
    return "/onboarding/live"
  }
  if (!onboardingOsCompleted) {
    return "/onboarding/os"
  }
  return null
}
