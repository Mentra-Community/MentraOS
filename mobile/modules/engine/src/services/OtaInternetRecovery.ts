import {otaLocalNetwork} from "@mentra/bluetooth-sdk/ota-transport"
import {Platform} from "react-native"
import {BgTimer} from "../utils/timers"

/** Releasing Android's hotspot request does not mean its Internet route is back. */
export async function waitForOtaInternet(isCurrent: () => boolean): Promise<void> {
  if (Platform.OS !== "android") return
  const deadline = performance.now() + 30_000
  while (isCurrent()) {
    try {
      const network = otaLocalNetwork.getNetworkDiagnostics()
      // Older native hosts cannot provide this observation. The ordinary check
      // still owns the real request and its success/failure result.
      if (!network) return
      const bound = network.processBound.present
      const route = bound ? network.processBound : network.activeNetwork
      const glassesRoute = bound ? network.processBoundMatchesGlassesLocal : network.activeNetworkMatchesGlassesLocal
      if (route.present && route.capabilities?.internet && route.capabilities.validated && !glassesRoute) return
    } catch {
      // An unavailable observation must not strand the completed install screen.
      return
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      // Do not declare success or repeat the install. Let the normal final check
      // report an actual connection failure if Internet remains unavailable.
      console.warn("[OTA_PROGRESS] Internet did not return within 30 seconds after hotspot release")
      return
    }
    await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, Math.min(250, remaining)))
  }
}
