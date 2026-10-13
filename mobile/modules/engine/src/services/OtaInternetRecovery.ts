import {otaLocalNetwork} from "@mentra/bluetooth-sdk/ota-transport"
import {Platform} from "react-native"
import {BgTimer} from "../utils/timers"

/** Releasing Android's hotspot request does not mean its Internet route is back. */
export async function waitForOtaInternet(isCurrent: () => boolean): Promise<void> {
  if (Platform.OS !== "android") return
  const startedAt = performance.now()
  const deadline = startedAt + 30_000
  const report = (outcome: "ready" | "timed-out" | "cancelled" | "native-unavailable") => {
    const message = `[OTA_PROGRESS] Internet recovery ${JSON.stringify({
      outcome,
      waitedMs: Math.round(performance.now() - startedAt),
    })}`
    if (outcome === "timed-out" || outcome === "native-unavailable") console.warn(message)
    else console.log(message)
  }
  while (isCurrent()) {
    try {
      const network = otaLocalNetwork.getNetworkDiagnostics()
      // Older native hosts cannot provide this observation. The ordinary check
      // still owns the real request and its success/failure result.
      if (!network) {
        report("native-unavailable")
        return
      }
      const bound = network.processBound.present
      const route = bound ? network.processBound : network.activeNetwork
      const glassesRoute = bound ? network.processBoundMatchesGlassesLocal : network.activeNetworkMatchesGlassesLocal
      if (route.present && route.capabilities?.internet && route.capabilities.validated && !glassesRoute) {
        report("ready")
        return
      }
    } catch {
      // An unavailable observation must not strand the completed install screen.
      report("native-unavailable")
      return
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      // Do not declare success or repeat the install. Let the normal final check
      // report an actual connection failure if Internet remains unavailable.
      report("timed-out")
      return
    }
    await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, Math.min(250, remaining)))
  }
  report("cancelled")
}
