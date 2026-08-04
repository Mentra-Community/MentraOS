export interface MiniappPingLivenessDecision {
  shouldUnregister: boolean
  unansweredPingRounds: number
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
