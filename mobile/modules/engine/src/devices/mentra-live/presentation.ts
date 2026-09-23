import type {ReleaseChangelog} from "../../facades/ota"
import type {OtaAutoChain, OtaAutoChainReleaseRange} from "../../services/OtaAutoChain"
import {
  BES_INSTALL_RESTART_MESSAGE,
  OTA_ERROR_BES_RESTART_REQUIRED_COPY_KEY,
  getOtaErrorMessage,
  otaErrorCopyKey,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "../../services/OtaErrorMapping"
import type {OtaInstallSnapshot} from "../../services/OtaInstallCoordinator"
import type {OtaCheckCurrentGlassesResult} from "../../services/OtaUpdateCheckService"
import type {LiveOtaPorts, LiveSessionData} from "./session"
import type {MentraLiveOtaError, MentraLiveOtaReleaseTransition, MentraLiveOtaScreen, MentraLiveOtaState} from "./types"

export function releaseRangeTargetVersion(result: OtaCheckCurrentGlassesResult): string | null {
  return result.releaseVersion ?? result.updateInfo?.versionName ?? result.latestVersionInfo?.versionName ?? null
}

export function currentReleaseVersion(appVersion: string | null): string | null {
  const version = appVersion?.trim()
  return version || null
}

export function releaseTransitionFromRange(
  range: OtaAutoChainReleaseRange | null,
): MentraLiveOtaReleaseTransition | null {
  if (!range?.releaseVersion) return null
  return {fromVersion: range.fromVersion, toVersion: range.releaseVersion}
}

export function releaseChangelogsForActiveChain(ota: LiveOtaPorts, chain: OtaAutoChain): ReleaseChangelog[] {
  const range = chain.otaAutoChainReleaseRange()
  if (!range?.toVersion) return []
  try {
    return ota.getReleaseChangelogs(range.fromVersion, range.toVersion)
  } catch {
    try {
      return ota.getReleaseChangelogs(null, range.toVersion)
    } catch {
      return []
    }
  }
}

function installProgress(snapshot: OtaInstallSnapshot): number | null {
  if (snapshot.displayState !== "updating") return null
  const {otaStatus} = snapshot
  const isDownload = otaStatus?.phase === "download"
  const totalSteps = otaStatus?.totalSteps ?? 1
  const rawPercent = isDownload
    ? (otaStatus?.stepPercent ?? 0)
    : totalSteps >= 2
      ? (otaStatus?.overallPercent ?? 0)
      : (otaStatus?.stepPercent ?? 0)
  return Math.min(Math.max(rawPercent, snapshot.mtkInstallStallSimulatedPercent ?? 0, 0), 100)
}

function progressScreen(snapshot: OtaInstallSnapshot): MentraLiveOtaScreen {
  if (snapshot.versionChangePhase === "restarting") return "restarting"
  if (snapshot.versionChangePhase === "verifying") return "verifying"
  switch (snapshot.displayState) {
    case "starting":
      return snapshot.hotspotPhase === "idle" || snapshot.hotspotPhase === "serving" ? "starting" : "preparing_hotspot"
    case "updating":
      return "updating"
    case "restarting":
      return "restarting"
    case "complete":
      return "complete"
    case "failed":
      return "failed"
    default:
      return "disconnected"
  }
}

export function projectLiveOtaState(data: LiveSessionData, ota: LiveOtaPorts, chain: OtaAutoChain): MentraLiveOtaState {
  const {
    page,
    runtimeReady,
    checkState,
    isUpdateRequired,
    isVersionChange,
    errorKind,
    completionFailed,
    unofficialClientPackage,
    offeredReleaseTransition,
    completedReleaseTransition,
    completedUpdate,
    completedChangelogs,
    batteryBlocked,
  } = data
  const otaSnapshot = ota.snapshot()
  const installSnapshot = ota.installSession.snapshot()
  const firmwareRestarting =
    page === "progress" &&
    ((!installSnapshot.connected && installSnapshot.displayState === "restarting") ||
      installSnapshot.versionChangePhase === "restarting")
  const hotspotSupported = otaSnapshot.hotspotOtaVersion === 1
  const canInstall = otaSnapshot.wifiStatusKnown && (otaSnapshot.wifiConnected || hotspotSupported)
  const autoChainActive = chain.isOtaAutoChainActive()
  if (!runtimeReady) {
    return {
      screen: "initializing",
      connected: otaSnapshot.connected,
      batteryLevel: otaSnapshot.batteryLevel,
      transport: null,
      updateRequired: isUpdateRequired,
      versionChange: isVersionChange,
      versionChangeConverged: false,
      versionChangePhase: null,
      wifiConnected: otaSnapshot.wifiConnected,
      wifiStatusKnown: otaSnapshot.wifiStatusKnown,
      hotspotSupported,
      hotspotPhase: "idle",
      hotspotArtifactPercent: null,
      hotspotArtifact: null,
      phase: null,
      step: null,
      currentStep: null,
      totalSteps: null,
      progress: null,
      installingApkOnly: false,
      firmwareRestarting: false,
      error: null,
      canInstall: false,
      canRetry: false,
      canFinish: false,
      canDismiss: false,
      canDiscard: false,
      canOpenWifiSetup: false,
      continueDisabled: false,
      completedUpdate: false,
      releaseTransition: null,
      changelogs: [],
      glassesPackageName: null,
    }
  }

  if (page === "check") {
    const wifiRequired = otaSnapshot.wifiStatusKnown && !otaSnapshot.wifiConnected && !hotspotSupported
    let screen: MentraLiveOtaScreen
    if (checkState === "checking") screen = autoChainActive ? "finishing" : "checking"
    else if (checkState === "update_available") {
      screen = wifiRequired ? "wifi_required" : batteryBlocked ? "battery_required" : "update_available"
    } else if (checkState === "no_update") screen = "up_to_date"
    else if (checkState === "dev_build") screen = "dev_build"
    else if (checkState === "unofficial_client") screen = "unofficial_client"
    else screen = errorKind === "pin_unavailable" ? "update_info_unavailable" : "check_failed"

    let error: MentraLiveOtaError | null = null
    if (screen === "check_failed") {
      error = {
        code: "check_failed",
        message:
          errorKind === "version_info"
            ? "Couldn't read the glasses software versions. Keep the glasses connected and try again."
            : "Couldn't check for updates. Please check your connection and try again.",
        copyKey: errorKind === "version_info" ? "ota:versionInfoFailedMessage" : "ota:checkFailedMessage",
        glassesCode: null,
      }
    } else if (screen === "update_info_unavailable") {
      error = {
        code: "update_info_unavailable",
        message: "Update information for this app version is unavailable.",
        copyKey: "ota:updateInfoUnavailableMessage",
        glassesCode: null,
      }
    }
    return {
      screen,
      connected: otaSnapshot.connected,
      batteryLevel: otaSnapshot.batteryLevel,
      transport: otaSnapshot.wifiConnected ? "wifi" : hotspotSupported ? "hotspot" : null,
      updateRequired: isUpdateRequired,
      versionChange: isVersionChange,
      versionChangeConverged: false,
      versionChangePhase: null,
      wifiConnected: otaSnapshot.wifiConnected,
      wifiStatusKnown: otaSnapshot.wifiStatusKnown,
      hotspotSupported,
      hotspotPhase: "idle",
      hotspotArtifactPercent: null,
      hotspotArtifact: null,
      phase: null,
      step: null,
      currentStep: null,
      totalSteps: null,
      progress: null,
      installingApkOnly: false,
      firmwareRestarting: false,
      error,
      canInstall: screen === "update_available" && canInstall,
      canRetry: screen === "check_failed",
      canFinish:
        screen === "up_to_date" ||
        screen === "dev_build" ||
        screen === "unofficial_client" ||
        screen === "update_info_unavailable",
      canDismiss:
        (screen === "update_available" || screen === "wifi_required" || screen === "battery_required") &&
        !isUpdateRequired &&
        !autoChainActive,
      canDiscard: false,
      canOpenWifiSetup: screen === "wifi_required",
      continueDisabled: false,
      completedUpdate: screen === "up_to_date" && completedUpdate,
      releaseTransition:
        screen === "update_available" || screen === "wifi_required"
          ? autoChainActive
            ? releaseTransitionFromRange(chain.otaAutoChainReleaseRange())
            : offeredReleaseTransition
          : screen === "up_to_date"
            ? completedReleaseTransition
            : null,
      changelogs: screen === "up_to_date" ? completedChangelogs : [],
      glassesPackageName: screen === "unofficial_client" ? unofficialClientPackage : null,
    }
  }

  const requiresGlassesReboot = shouldRequireGlassesRebootForBesFailure(
    installSnapshot.otaStatus,
    installSnapshot.otaProgress,
    installSnapshot.errorMsg,
  )
  const showChangeWifi = shouldShowChangeWifiForOtaDownloadFailure(
    installSnapshot.otaStatus,
    installSnapshot.otaProgress,
    installSnapshot.errorMsg,
  )
  // The raw code the glasses attached to their failure report, kept for support even when
  // phone-side copy outranks it. Only a failed ota_status carries a current code.
  const glassesCode = installSnapshot.otaStatus?.status === "failed" ? installSnapshot.otaStatus.error || null : null
  // Precedence mirrors the legacy screen: the BES restart instruction, then a phone-side
  // watchdog/preflight message (English-only, no copy key), then the glasses code mapped to
  // copy (unknown codes get the generic glasses-error copy rather than the raw code).
  let displayedError: string
  let copyKey: string | null
  if (requiresGlassesReboot) {
    displayedError = BES_INSTALL_RESTART_MESSAGE
    copyKey = OTA_ERROR_BES_RESTART_REQUIRED_COPY_KEY
  } else if (installSnapshot.errorMsg) {
    displayedError = installSnapshot.errorMsg
    copyKey = null
  } else {
    displayedError = getOtaErrorMessage(glassesCode)
    copyKey = otaErrorCopyKey(glassesCode)
  }
  const progressState = progressScreen(installSnapshot)
  const screen = completionFailed
    ? "failed"
    : progressState === "complete" && autoChainActive
      ? "finishing"
      : progressState
  const error: MentraLiveOtaError | null =
    screen === "failed"
      ? {
          code: !completionFailed && requiresGlassesReboot ? "bes_restart_required" : "install_failed",
          message: completionFailed
            ? "Couldn't confirm update completion. Keep the glasses connected and try again."
            : displayedError,
          copyKey: completionFailed ? "ota:completionVerificationFailed" : copyKey,
          glassesCode: completionFailed ? null : glassesCode,
        }
      : null
  const totalSteps = installSnapshot.otaStatus?.totalSteps ?? null
  const artifact = installSnapshot.hotspotArtifact
  const changelogs = screen === "complete" ? releaseChangelogsForActiveChain(ota, chain) : []
  return {
    screen,
    connected: installSnapshot.connected,
    batteryLevel: otaSnapshot.batteryLevel,
    transport: installSnapshot.transport,
    updateRequired: isUpdateRequired,
    versionChange: installSnapshot.isVersionChange,
    versionChangeConverged: installSnapshot.versionChangeConverged,
    versionChangePhase: installSnapshot.versionChangePhase,
    wifiConnected: otaSnapshot.wifiConnected,
    wifiStatusKnown: otaSnapshot.wifiStatusKnown,
    hotspotSupported,
    hotspotPhase: installSnapshot.hotspotPhase,
    hotspotArtifactPercent: installSnapshot.hotspotArtifactPercent,
    hotspotArtifact: artifact ? {kind: artifact.kind, index: artifact.index, totalCount: artifact.totalCount} : null,
    phase: installSnapshot.otaStatus?.phase ?? installSnapshot.otaProgress?.stage ?? null,
    step: installSnapshot.otaStatus?.stepType ?? null,
    currentStep: installSnapshot.otaStatus?.currentStep ?? null,
    totalSteps,
    progress: installProgress(installSnapshot),
    installingApkOnly:
      installSnapshot.otaStatus?.stepType === "apk" &&
      installSnapshot.otaStatus.phase === "install" &&
      totalSteps === 1,
    firmwareRestarting,
    error,
    canInstall: false,
    canRetry: screen === "failed" && (completionFailed || !requiresGlassesReboot),
    canFinish: screen === "complete" || (screen === "failed" && !completionFailed && requiresGlassesReboot),
    canDismiss: false,
    canDiscard: screen === "disconnected",
    canOpenWifiSetup: screen === "failed" && !completionFailed && showChangeWifi,
    continueDisabled: installSnapshot.continueButtonDisabled,
    completedUpdate: false,
    releaseTransition: releaseTransitionFromRange(chain.otaAutoChainReleaseRange()),
    changelogs,
    glassesPackageName: null,
  }
}
