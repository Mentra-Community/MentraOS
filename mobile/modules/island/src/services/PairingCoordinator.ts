/**
 * PairingCoordinator — the pairing *decisions* the pairing screens make: which
 * screen a pairing failure routes to, and which post-pair onboarding screens to
 * stack. Pure logic; the screens own navigation, bluetooth, and incident filing
 * and call these to decide. The pairing boot watchdog (wait-for-booted + the
 * timeout incident) is built on GlassesReadiness.waitForGlassesReady.
 */

export type PairFailureRoute = "unpair-even" | "failure"

/**
 * Where a pair_failure should send the user. The Even Realities companion app
 * holding the bond has to be disconnected first ("pairNeedDisconnect"); every
 * other failure goes to the generic failure screen.
 */
export function classifyPairFailure(error: string): PairFailureRoute {
  return error === "errors:pairNeedDisconnect" ? "unpair-even" : "failure"
}

const ROUTE_ORDER = ["/pairing/btclassic", "/wifi/scan", "/ota/check-for-updates", "/onboarding/live", "/onboarding/os"]

/**
 * The screens to push after a successful pair, in order. Only OTA-capable
 * glasses get a post-pair stack today: an optional Bluetooth-Classic pairing
 * step (skipped on Android, or when already connected) followed by the OTA
 * check. Non-OTA glasses go straight home.
 */
export function buildPairingRouteStack(input: {
  hasOta: boolean
  isAndroid: boolean
  bluetoothClassicConnected: boolean
}): string[] {
  if (!input.hasOta) return []
  const stack: string[] = []
  // Android pairs Bluetooth Classic at the native stack level, so the screen is
  // never needed there; otherwise it's only needed until the bond is confirmed.
  const bluetoothClassicConnected = input.isAndroid || input.bluetoothClassicConnected
  if (!bluetoothClassicConnected) stack.push("/pairing/btclassic")
  stack.push("/ota/check-for-updates")
  stack.sort((a, b) => ROUTE_ORDER.indexOf(a) - ROUTE_ORDER.indexOf(b))
  return stack
}
