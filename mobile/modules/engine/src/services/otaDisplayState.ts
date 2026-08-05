import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk/internal"

import {isLegacyShapedOtaStatus} from "./otaInstallPolicy"

export type DisplayState = "starting" | "updating" | "complete" | "failed" | "disconnected" | "restarting"

/**
 * Pure derivation of the OTA progress UI state from the glasses data in the
 * Zustand store plus a couple of genuinely-local inputs. See
 * OtaInstallCoordinator.ts for the state machine that consumes this (the host
 * progress screen renders its snapshot).
 *
 * Legacy shape (WP 8C): old (< 37) ASG builds send `ota_progress`, which the SDK
 * maps to ota_status with sessionId "" and FINISHED→"complete" at ANY phase. For
 * those statuses a download-phase "complete" only means the download finished
 * (the install is still ahead), and an apk install "complete" may be held by the
 * coordinator's settle window — both stay "updating" instead of terminal.
 *
 * Priority-ordered rules (first match wins):
 *   1. errorMsg !== ""                                          -> "failed"
 *   2. BES reboot recovery verified                             -> "complete"
 *   3. BES reboot recovery awaiting verification               -> "restarting"
 *   4. BES terminal + connected + sawReconnectEdge             -> "complete"
 *   5. BES terminal (any connection state)                     -> "restarting"
 *      (legacy-shaped BES "complete" counts only in install phase)
 *   6. apkCompletedViaBuildIncrease (legacy build-number port) -> "complete"
 *   7. otaStatus.status === "failed"                           -> "failed"
 *   8. otaStatus.status === "complete" (non-BES)               -> "complete"
 *      (unless legacy-shaped download-complete or held apk settle -> in flight)
 *   9. !connected + legacy in-flight complete (held apk)       -> "updating"
 *   10. !connected + APK step_complete with totalSteps > 1     -> "starting"   (expected reboot)
 *   11. !connected + BES in flight                             -> "restarting" (defensive)
 *   12. !connected                                             -> "disconnected"
 *   13. connected + in_progress | step_complete | legacy in-flight complete -> "updating"
 *   14. fallback                                               -> "starting"
 */
export function deriveDisplayState(args: {
  otaStatus: OtaStatus | null
  otaProgress: OtaProgress | null
  connected: boolean
  errorMsg: string
  sawReconnectEdge: boolean
  /** Coordinator is holding a legacy apk install "complete" for the settle window (WP 8C). */
  legacyApkSettleHold?: boolean
  /** Legacy APK completion detected by build-number increase (WP 8C). */
  apkCompletedViaBuildIncrease?: boolean
  /** Phone-observed BES disconnect/reconnect recovery, independent of stale OTA progress. */
  besRestartRecovery?: "awaiting" | "complete" | null
  /** Downgrade detour: the reconnected glasses reported exactly the pinned target version. */
  versionChangeConverged?: boolean
  /** True for the whole downgrade (version-change) session. */
  versionChangeSession?: boolean
}): DisplayState {
  const {
    otaStatus,
    otaProgress,
    connected,
    errorMsg,
    sawReconnectEdge,
    legacyApkSettleHold,
    apkCompletedViaBuildIncrease,
    besRestartRecovery,
    versionChangeConverged,
    versionChangeSession,
  } = args

  if (errorMsg) return "failed"

  // Downgrade detour completion: exact-version convergence after reconnect is the
  // only completion signal (the wipe destroys ASG's ota_session, and the target is
  // a LOWER build so no build-number increase fires). Outranks the stale install
  // status still sitting in the store from before the handoff.
  if (versionChangeConverged) return "complete"

  // A BES reboot destroys or strands the glasses-side OTA session on older
  // clients. Once the phone observed that reboot, stale pre-reboot progress must
  // not move the UI from restarting back to updating.
  if (besRestartRecovery === "complete") return "complete"
  if (besRestartRecovery === "awaiting") return "restarting"

  // In a version-change session, convergence (above) is the ONLY completion for the ASG
  // downgrade. A bare non-firmware "complete" before convergence — the glasses refusing
  // the downgrade (floor/gate) with no install, or a stale pre-handoff status — must never
  // present as success. Firmware-step completions (mtk/bes) DO pass through: a combined
  // downgrade+firmware manifest applies firmware first on its own pass, which must finish
  // so the phone re-checks and re-offers the now-firmware-free downgrade.
  const isFirmwareComplete = otaStatus?.stepType === "mtk" || otaStatus?.stepType === "bes"
  if (versionChangeSession && otaStatus?.status === "complete" && !isFirmwareComplete) {
    return connected ? "updating" : "disconnected"
  }

  const besTerminal = isBesTerminal(otaStatus, otaProgress)
  if (besTerminal && connected && sawReconnectEdge) return "complete"
  if (besTerminal) return "restarting"

  // Legacy build-number APK completion: the coordinator clears errorMsg when it fires,
  // and the flag outranks whatever stale legacy status is still in the store (the old
  // screen's last-write-wins completion from starting/failed/installing).
  if (apkCompletedViaBuildIncrease) return "complete"

  if (otaStatus?.status === "failed") return "failed"

  // Legacy-shaped "complete" that is still in flight: a download-phase FINISHED (the
  // install is still ahead), or an apk install FINISHED held by the settle window.
  const legacyInFlightComplete =
    isLegacyShapedOtaStatus(otaStatus) &&
    otaStatus?.status === "complete" &&
    (otaStatus.phase === "download" ||
      (!!legacyApkSettleHold && otaStatus.stepType === "apk" && otaStatus.phase === "install"))

  if (otaStatus?.status === "complete" && !legacyInFlightComplete) return "complete"

  if (!connected) {
    // The held apk install complete means the glasses are restarting into the new
    // build — the legacy screen kept showing "installing" through that restart.
    if (legacyInFlightComplete && otaStatus?.phase === "install") return "updating"

    // By here, the failed/complete rules already returned for terminal statuses.
    // For APK multi-step, "step_complete" means the current step ended and the
    // glasses are rebooting to start the next one.
    const apkRebootExpected =
      otaStatus?.stepType === "apk" && (otaStatus?.totalSteps ?? 0) > 1 && otaStatus.status === "step_complete"
    if (apkRebootExpected) return "starting"

    // Legacy-shaped BES download events do not mean a reboot is coming (the flash
    // has not started); the legacy screen treated that drop as a plain disconnect.
    const besStatusInFlight =
      otaStatus?.stepType === "bes" && !(isLegacyShapedOtaStatus(otaStatus) && otaStatus.phase === "download")
    const besInFlight =
      besStatusInFlight || (otaProgress?.currentUpdate === "bes" && otaProgress?.stage === "install")
    if (besInFlight) return "restarting"

    return "disconnected"
  }

  if (otaStatus?.status === "in_progress" || otaStatus?.status === "step_complete" || legacyInFlightComplete) {
    return "updating"
  }

  return "starting"
}

function isBesTerminal(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): boolean {
  if (otaStatus?.stepType === "bes" && (otaStatus.status === "step_complete" || otaStatus.status === "complete")) {
    // Legacy-shaped statuses map download FINISHED to "complete" too; only an
    // install-phase terminal means the BES flash actually ran (WP 8C).
    if (isLegacyShapedOtaStatus(otaStatus) && otaStatus.phase !== "install") {
      return false
    }
    return true
  }
  if (otaProgress?.currentUpdate === "bes" && otaProgress.stage === "install" && otaProgress.status === "FINISHED") {
    return true
  }
  return false
}
