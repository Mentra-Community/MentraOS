import {engine} from "@mentra/engine"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/utils/AlertUtils"

/** Explicit cancellation discards only unfinished pairing, then leaves its route stack. */
export async function cancelPendingPairing(): Promise<boolean> {
  try {
    await engine.pairing.abandonAttempt({clearPendingSelection: true})
    useNavigationStore.getState().clearHistoryAndGoHome()
    return true
  } catch (error) {
    console.warn("Failed to cancel unfinished pairing:", error)
    showAlert(translate("pairing:errorTitle"), translate("pairing:cancelFailed"))
    return false
  }
}

/**
 * Routes a pairing/connect KICKOFF rejection to the failure screen.
 *
 * A kickoff rejection (e.g. Bluetooth powered off, a native-bridge error)
 * emits no pair_failure event, so the loading screen would otherwise spin
 * until the user cancels. Because the rejection can land asynchronously, the user
 * may have cancelled already — so this fires only while /pairing/loading
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
