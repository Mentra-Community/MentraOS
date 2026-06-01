import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk-internal"

export type DisplayState = "starting" | "updating" | "complete" | "failed" | "disconnected" | "restarting"

/**
 * Pure derivation of the OTA progress UI state from the glasses data in the
 * Zustand store plus a couple of genuinely-local inputs. See
 * mobile/src/app/ota/progress.tsx for the component that consumes this.
 *
 * Priority-ordered rules (first match wins):
 *   1. errorMsg !== ""                                          -> "failed"
 *   2. BES terminal + connected + sawReconnectEdge             -> "complete"
 *   3. BES terminal (any connection state)                     -> "restarting"
 *   4. otaStatus.status === "failed"                           -> "failed"
 *   5. otaStatus.status === "complete" (non-BES)               -> "complete"
 *   6. !connected + APK step_complete with totalSteps > 1      -> "starting"   (expected reboot)
 *   7. !connected + BES in flight                              -> "restarting" (defensive)
 *   8. !connected                                              -> "disconnected"
 *   9. connected + status in_progress | step_complete          -> "updating"
 *   10. fallback                                               -> "starting"
 */
export function deriveDisplayState(args: {
  otaStatus: OtaStatus | null
  otaProgress: OtaProgress | null
  connected: boolean
  errorMsg: string
  sawReconnectEdge: boolean
}): DisplayState {
  const {otaStatus, otaProgress, connected, errorMsg, sawReconnectEdge} = args

  if (errorMsg) return "failed"

  const besTerminal = isBesTerminal(otaStatus, otaProgress)
  if (besTerminal && connected && sawReconnectEdge) return "complete"
  if (besTerminal) return "restarting"

  if (otaStatus?.status === "failed") return "failed"
  if (otaStatus?.status === "complete") return "complete"

  if (!connected) {
    // By here, Rules 4 & 5 already returned for status==="failed"|"complete".
    // For APK multi-step, "step_complete" means the current step ended and the
    // glasses are rebooting to start the next one.
    const apkRebootExpected =
      otaStatus?.stepType === "apk" && (otaStatus?.totalSteps ?? 0) > 1 && otaStatus.status === "step_complete"
    if (apkRebootExpected) return "starting"

    const besInFlight =
      otaStatus?.stepType === "bes" || (otaProgress?.currentUpdate === "bes" && otaProgress?.stage === "install")
    if (besInFlight) return "restarting"

    return "disconnected"
  }

  if (otaStatus?.status === "in_progress" || otaStatus?.status === "step_complete") {
    return "updating"
  }

  return "starting"
}

function isBesTerminal(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): boolean {
  if (otaStatus?.stepType === "bes" && (otaStatus.status === "step_complete" || otaStatus.status === "complete")) {
    return true
  }
  if (otaProgress?.currentUpdate === "bes" && otaProgress.stage === "install" && otaProgress.status === "FINISHED") {
    return true
  }
  return false
}
