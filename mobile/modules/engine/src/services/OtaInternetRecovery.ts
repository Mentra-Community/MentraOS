import {otaLocalNetwork} from "@mentra/bluetooth-sdk/ota-transport"
import {BgTimer} from "../utils/timers"

export type OtaInternetRecoveryOutcome = "ready" | "timed-out" | "cancelled" | "unavailable"

/** Releasing Android's hotspot request does not mean its Internet route is back. */
export async function waitForOtaInternet(isCurrent: () => boolean): Promise<OtaInternetRecoveryOutcome> {
  const startedAt = performance.now()
  const deadline = startedAt + 30_000
  const report = (outcome: OtaInternetRecoveryOutcome): OtaInternetRecoveryOutcome => {
    const message = `[OTA_PROGRESS] Internet recovery ${JSON.stringify({
      outcome,
      waitedMs: Math.round(performance.now() - startedAt),
    })}`
    if (outcome === "timed-out" || outcome === "unavailable") console.warn(message)
    else console.log(message)
    return outcome
  }
  while (isCurrent()) {
    try {
      const network = otaLocalNetwork.getNetworkDiagnostics()
      // Missing required diagnostics is an observation failure, never readiness.
      if (!network) {
        return report("unavailable")
      }
      const bound = network.processBound.present
      const route = bound ? network.processBound : network.activeNetwork
      const glassesRoute = bound ? network.processBoundMatchesGlassesLocal : network.activeNetworkMatchesGlassesLocal
      if (route.present && route.capabilities?.internet && route.capabilities.validated && !glassesRoute) {
        return report("ready")
      }
    } catch {
      // An unavailable observation must not strand the completed install screen.
      return report("unavailable")
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      // Do not declare success or repeat the install. Let the normal final check
      // report an actual connection failure if Internet remains unavailable.
      return report("timed-out")
    }
    await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, Math.min(250, remaining)))
  }
  return report("cancelled")
}
