import {engine} from "@mentra/engine"
import type {Device} from "@mentra/bluetooth-sdk"

import {useNavigationStore} from "@/stores/navigation"

const PAIRING_KICKOFF_DELAY_MS = 2_000

/**
 * Starts the selected connection after the loading transition, but only if the
 * user is still on that flow. A plain delayed pair() survives a back action and
 * can connect glasses or a controller the user explicitly cancelled.
 */
export function schedulePairingKickoff(device: Device, targetLabel: "glasses" | "controller") {
  setTimeout(() => {
    const {history} = useNavigationStore.getState()
    if (history[history.length - 1] !== "/pairing/loading") return
    engine.pairing.pair(device).catch((error) => {
      console.error(`Failed to connect to ${targetLabel}:`, error)
      routePairingKickoffFailure(device.model)
    })
  }, PAIRING_KICKOFF_DELAY_MS)
}

/**
 * Routes a pairing/connect KICKOFF rejection to the failure screen.
 *
 * A kickoff rejection (e.g. Bluetooth powered off, a native-bridge error)
 * emits no pair_failure event, so the loading screen would otherwise spin
 * until the user cancels. Because the rejection lands on a delay, the user
 * may also have cancelled already — so this fires only while /pairing/loading
 * is still the top route; a stale callback must not yank the user out of
 * whatever screen they navigated to instead.
 */
export function routePairingKickoffFailure(deviceModel?: string) {
  const {history, replace} = useNavigationStore.getState()
  if (history[history.length - 1] !== "/pairing/loading") return
  // Parity with loading.tsx's handlePairFailure: clear the failed attempt
  // before surfacing the failure (a pre-existing pairing is preserved).
  void engine.pairing.abandonAttempt().catch((cleanupError) => {
    console.warn("Pairing kickoff-failure cleanup failed:", cleanupError)
  })
  replace("/pairing/failure", {error: "errors:pairingCouldNotStart", deviceModel})
}
