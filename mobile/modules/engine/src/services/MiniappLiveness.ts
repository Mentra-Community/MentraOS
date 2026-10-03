export interface MiniappPingLivenessDecision {
  shouldUnregister: boolean
  unansweredPingRounds: number
}

/**
 * SoftAP join can spend a minute in native `prepareAgent` before the glasses
 * hotspot even turns on. The JS bundle stays alive but may miss pongs while
 * ACS is on the native thread. Unregistering for missed pings in that window
 * cancels the join and leaves the UI stuck on the hotspot row.
 */
export function shouldHoldMiniappPingLiveness(args: {
  packageName: string
  softapPackageName?: string | null
  softapCancelled?: boolean
}): boolean {
  return Boolean(
    args.softapPackageName &&
      args.softapPackageName === args.packageName &&
      !args.softapCancelled,
  )
}

/**
 * Advance liveness by one scheduled ping round.
 *
 * Counting actual rounds avoids treating time while React Native's scheduler
 * was paused in the background as pings the miniapp failed to answer.
 */
export function advanceMiniappPingLiveness(
  unansweredPingRounds: number,
  timeoutThreshold: number,
): MiniappPingLivenessDecision {
  if (unansweredPingRounds >= timeoutThreshold) {
    return {shouldUnregister: true, unansweredPingRounds}
  }

  return {
    shouldUnregister: false,
    unansweredPingRounds: unansweredPingRounds + 1,
  }
}
