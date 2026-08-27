import {useCallback, useEffect, useMemo, useRef, useState} from "react"

import {ota} from "../facades/ota"
import {
  beginOtaAutoChain,
  clearOtaAutoChainReconnectWait,
  isOtaAutoChainActive,
  otaAutoChainFingerprint,
  otaAutoChainReleaseRange,
  otaAutoChainReconnectWaitRemaining,
  stopOtaAutoChain,
  tryAdvanceOtaAutoChain,
  type OtaAutoChainReleaseRange,
} from "../services/OtaAutoChain"
import {
  BES_INSTALL_RESTART_MESSAGE,
  getOtaErrorMessage,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "../services/OtaErrorMapping"
import type {OtaInstallSnapshot} from "../services/OtaInstallCoordinator"
import type {OtaCheckCurrentGlassesResult} from "../services/OtaUpdateCheckService"
import type {ReleaseChangelog} from "../facades/ota"
import {useEngineSnapshot} from "./useEngineSnapshot"

export type MentraLiveOtaFlowPage = "check" | "progress"

export type MentraLiveOtaScreen =
  | "initializing"
  | "checking"
  | "finishing"
  | "update_available"
  | "wifi_required"
  | "up_to_date"
  | "dev_build"
  | "check_failed"
  | "update_info_unavailable"
  | "starting"
  | "preparing_hotspot"
  | "updating"
  | "restarting"
  | "verifying"
  | "complete"
  | "failed"
  | "disconnected"

export type MentraLiveOtaErrorCode =
  | "check_failed"
  | "update_info_unavailable"
  | "install_failed"
  | "bes_restart_required"

export type MentraLiveOtaError = {
  code: MentraLiveOtaErrorCode
  message: string
}

export type MentraLiveOtaTransport = "wifi" | "hotspot"
export type MentraLiveOtaHotspotPhase = "idle" | "downloading" | "starting_hotspot" | "joining_hotspot" | "serving"
export type MentraLiveOtaInstallPhase = "download" | "install"
export type MentraLiveOtaStep = "apk" | "mtk" | "bes"

export type MentraLiveOtaReleaseTransition = {
  /** Current glasses software label. Temporarily backed by the reported ASG app version. */
  fromVersion: string | null
  /** Exact coordinated release identity for the selected OTA pin. */
  toVersion: string
}

export type MentraLiveOtaState = {
  screen: MentraLiveOtaScreen
  connected: boolean
  transport: MentraLiveOtaTransport | null
  updateRequired: boolean
  versionChange: boolean
  versionChangeConverged: boolean
  versionChangePhase: "installing" | "restarting" | "verifying" | null
  wifiConnected: boolean
  wifiStatusKnown: boolean
  hotspotSupported: boolean
  hotspotPhase: MentraLiveOtaHotspotPhase
  hotspotArtifactPercent: number | null
  phase: MentraLiveOtaInstallPhase | null
  step: MentraLiveOtaStep | null
  currentStep: number | null
  totalSteps: number | null
  progress: number | null
  installingApkOnly: boolean
  firmwareRestarting: boolean
  error: MentraLiveOtaError | null
  canInstall: boolean
  canRetry: boolean
  canFinish: boolean
  canDismiss: boolean
  canDiscard: boolean
  canOpenWifiSetup: boolean
  continueDisabled: boolean
  /** Release labels for the offered or just-completed coordinated update. */
  releaseTransition: MentraLiveOtaReleaseTransition | null
  /** Release notes crossed by this update, newest first. Populated on completion. */
  changelogs: ReleaseChangelog[]
}

export type UseMentraLiveOtaOptions = {
  /** Entry page. `progress` exists for interrupted-session recovery. */
  initialPage?: MentraLiveOtaFlowPage
  /** Start Engine's OTA-only projections. Full Engine hosts should pass false. */
  initializeRuntime?: boolean
  /** Called after the final check or when an optional update is dismissed. */
  onFinished?: () => void
  /** Host-owned Wi-Fi setup for glasses without hotspot OTA support. */
  onOpenWifiSetup?: () => void
  /** Lets a host coordinate its connection overlay with OTA firmware restarts. */
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
}

export type MentraLiveOtaController = {
  state: MentraLiveOtaState
  check: () => void
  retryCheck: () => void
  install: () => void
  retryInstall: () => void
  finish: () => void
  discard: () => void
  openWifiSetup: () => void
}

type CheckState = "checking" | "update_available" | "no_update" | "dev_build" | "error"

const AUTO_CHAIN_NETWORK_RETRY_DELAY_MS = 5000
const AUTO_CHAIN_COMPLETE_DELAY_MS = 750

function releaseRangeTargetVersion(result: OtaCheckCurrentGlassesResult): string | null {
  return result.releaseVersion ?? result.updateInfo?.versionName ?? result.latestVersionInfo?.versionName ?? null
}

function currentReleaseVersion(appVersion: string | null): string | null {
  const version = appVersion?.trim()
  return version || null
}

function releaseTransitionFromRange(range: OtaAutoChainReleaseRange | null): MentraLiveOtaReleaseTransition | null {
  if (!range?.releaseVersion) return null
  return {fromVersion: range.fromVersion, toVersion: range.releaseVersion}
}

function releaseChangelogsForActiveChain(): ReleaseChangelog[] {
  const range = otaAutoChainReleaseRange()
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

/**
 * Headless Mentra Live OTA flow. Engine owns checking, hotspot staging,
 * APK/MTK/BES sequencing, restart recovery, retries, and verification; the host
 * renders semantic state and invokes these idempotent actions.
 */
export function useMentraLiveOta(options: UseMentraLiveOtaOptions = {}): MentraLiveOtaController {
  const {
    initialPage = "check",
    initializeRuntime = true,
    onFinished,
    onFirmwareRestartingChange,
    onOpenWifiSetup,
  } = options
  const otaSnapshot = useEngineSnapshot(ota.snapshot, ota.onSnapshot)
  const installSnapshot = useEngineSnapshot(ota.installSession.snapshot, ota.installSession.onSnapshot)
  const [page, setPage] = useState<MentraLiveOtaFlowPage>(initialPage)
  const [runtimeReady, setRuntimeReady] = useState(!initializeRuntime)
  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [isUpdateRequired, setIsUpdateRequired] = useState(true)
  const [isVersionChange, setIsVersionChange] = useState(false)
  const [errorKind, setErrorKind] = useState<"network" | "pin_unavailable">("network")
  const [updateFingerprint, setUpdateFingerprint] = useState<string | null>(null)
  const [offeredReleaseTransition, setOfferedReleaseTransition] = useState<MentraLiveOtaReleaseTransition | null>(null)
  const [completedReleaseTransition, setCompletedReleaseTransition] = useState<MentraLiveOtaReleaseTransition | null>(
    null,
  )
  const [completedChangelogs, setCompletedChangelogs] = useState<ReleaseChangelog[]>([])
  const [checkGeneration, setCheckGeneration] = useState(0)
  const performCheckGenerationRef = useRef(0)
  const activeCheckKeyRef = useRef<string | null>(null)
  const checkStartedRef = useRef(false)
  const checkCompletedRef = useRef(false)
  const selectedCheckResultRef = useRef<OtaCheckCurrentGlassesResult | null>(null)
  const autoChainAdvancedRef = useRef(false)
  const installActionPendingRef = useRef(false)
  const onFinishedRef = useRef(onFinished)
  const onOpenWifiSetupRef = useRef(onOpenWifiSetup)
  const onFirmwareRestartingChangeRef = useRef(onFirmwareRestartingChange)
  onFinishedRef.current = onFinished
  onOpenWifiSetupRef.current = onOpenWifiSetup
  onFirmwareRestartingChangeRef.current = onFirmwareRestartingChange

  useEffect(() => {
    if (!initializeRuntime) {
      setRuntimeReady(true)
      return
    }
    let cancelled = false
    setRuntimeReady(false)
    void ota.initialize().finally(() => {
      if (!cancelled) setRuntimeReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [initializeRuntime])

  const returnToCheck = useCallback(() => {
    installActionPendingRef.current = false
    autoChainAdvancedRef.current = false
    setPage("check")
    setCheckGeneration((generation) => generation + 1)
  }, [])

  const navigateToProgress = useCallback(() => {
    installActionPendingRef.current = true
    ota.clearProgress()
    setPage("progress")
  }, [])

  useEffect(() => {
    if (!runtimeReady || page !== "check") return
    const MIN_DISPLAY_TIME_MS = 1100
    const MAX_WAIT_FOR_VERSION_INFO_MS = 10_000
    const checkKey = String(checkGeneration)
    if (activeCheckKeyRef.current !== checkKey) {
      activeCheckKeyRef.current = checkKey
      checkStartedRef.current = false
      checkCompletedRef.current = false
      selectedCheckResultRef.current = null
      installActionPendingRef.current = false
      setCheckState("checking")
    }

    const myGeneration = ++performCheckGenerationRef.current
    let cancelled = false
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

    const performCheck = async () => {
      if (checkCompletedRef.current) return
      if (!otaSnapshot.connected) {
        if (isOtaAutoChainActive()) {
          const remainingMs = otaAutoChainReconnectWaitRemaining()
          if (remainingMs === null) return
          reconnectTimeout = setTimeout(() => {
            if (cancelled || myGeneration !== performCheckGenerationRef.current || ota.snapshot().connected) return
            stopOtaAutoChain()
            checkCompletedRef.current = true
            setCheckState("error")
          }, remainingMs)
          return
        }
        if (checkStartedRef.current) {
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setCheckState("error")
          return
        }
        checkCompletedRef.current = true
        onFinishedRef.current?.()
        return
      }

      clearOtaAutoChainReconnectWait()
      checkStartedRef.current = true
      const startTime = Date.now()
      try {
        const checkOptions = {
          waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
          waitForBesVersionMs: 5000,
          waitForMtkVersionMs: 2000,
          refreshVersionInfo: true,
          fixClockBeforeCheck: false,
        }
        let result = await ota.checkForUpdates(checkOptions)
        if (cancelled || myGeneration !== performCheckGenerationRef.current) return
        if (!result.hasCheckCompleted && result.checkFailureReason === "network" && isOtaAutoChainActive()) {
          await new Promise((resolve) => setTimeout(resolve, AUTO_CHAIN_NETWORK_RETRY_DELAY_MS))
          if (cancelled || myGeneration !== performCheckGenerationRef.current) return
          result = await ota.checkForUpdates(checkOptions)
        }
        if (cancelled || myGeneration !== performCheckGenerationRef.current) return
        selectedCheckResultRef.current = result
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, MIN_DISPLAY_TIME_MS - (Date.now() - startTime))))
        if (cancelled || myGeneration !== performCheckGenerationRef.current) return

        if (result.skippedReason === "disconnected") {
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setCheckState("error")
          return
        }
        if (result.skippedReason === "missing_build") {
          checkCompletedRef.current = true
          if (isOtaAutoChainActive()) {
            stopOtaAutoChain()
            setCheckState("error")
          } else {
            onFinishedRef.current?.()
          }
          return
        }
        if (result.skippedReason === "dev_build") {
          stopOtaAutoChain()
          checkCompletedRef.current = true
          ota.clearUpdateAvailable()
          setCheckState("dev_build")
          return
        }
        if (!result.hasCheckCompleted) {
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setErrorKind(result.checkFailureReason === "pin_unavailable" ? "pin_unavailable" : "network")
          setCheckState("error")
          return
        }
        if (result.updateAvailable && result.updateInfo) {
          setIsUpdateRequired(result.isRequired)
          setIsVersionChange(result.updateInfo.isDowngrade === true)
          const fingerprint = otaAutoChainFingerprint(result)
          setUpdateFingerprint(fingerprint)
          if (!isOtaAutoChainActive()) {
            const fromVersion = currentReleaseVersion(ota.snapshot().appVersion)
            setOfferedReleaseTransition(result.releaseVersion ? {fromVersion, toVersion: result.releaseVersion} : null)
          }
          if (isOtaAutoChainActive()) {
            const snapshot = ota.snapshot()
            if (!snapshot.wifiStatusKnown) return
            if (snapshot.wifiConnected || snapshot.hotspotOtaVersion === 1) {
              const admission = tryAdvanceOtaAutoChain(
                fingerprint,
                result.updateInfo.isDowngrade === true,
                releaseRangeTargetVersion(result),
                result.releaseVersion,
              )
              if (admission.advance) {
                checkCompletedRef.current = true
                ota.installSession.prepare(result)
                navigateToProgress()
                return
              }
            }
          }
          checkCompletedRef.current = true
          setCheckState("update_available")
          return
        }
        if (isOtaAutoChainActive()) {
          setCompletedChangelogs(releaseChangelogsForActiveChain())
          setCompletedReleaseTransition(releaseTransitionFromRange(otaAutoChainReleaseRange()))
        }
        stopOtaAutoChain()
        checkCompletedRef.current = true
        ota.clearUpdateAvailable()
        setCheckState("no_update")
      } catch (error) {
        console.error("OTA check failed:", error)
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, MIN_DISPLAY_TIME_MS - (Date.now() - startTime))))
        if (cancelled || myGeneration !== performCheckGenerationRef.current) return
        stopOtaAutoChain()
        checkCompletedRef.current = true
        setErrorKind("network")
        setCheckState("error")
      }
    }

    void performCheck()
    return () => {
      cancelled = true
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }
  }, [checkGeneration, navigateToProgress, otaSnapshot.connected, otaSnapshot.wifiStatusKnown, page, runtimeReady])

  useEffect(() => {
    if (!runtimeReady || page !== "progress") return
    ota.installSession.attach()
    return () => ota.installSession.detach()
  }, [page, runtimeReady])

  const firmwareRestarting =
    page === "progress" &&
    ((!installSnapshot.connected && installSnapshot.displayState === "restarting") ||
      installSnapshot.versionChangePhase === "restarting")

  useEffect(() => {
    if (page !== "progress") return
    onFirmwareRestartingChangeRef.current?.(firmwareRestarting, true)
  }, [firmwareRestarting, page])

  useEffect(() => {
    if (page !== "progress") return
    return () => {
      onFirmwareRestartingChangeRef.current?.(false, false)
    }
  }, [page])

  useEffect(() => {
    if (
      page !== "progress" ||
      installSnapshot.displayState !== "complete" ||
      !installSnapshot.connected ||
      !isOtaAutoChainActive() ||
      autoChainAdvancedRef.current
    ) {
      return
    }
    const timeout = setTimeout(async () => {
      if (!isOtaAutoChainActive()) return
      autoChainAdvancedRef.current = true
      await ota.installSession.finish()
      returnToCheck()
    }, AUTO_CHAIN_COMPLETE_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [installSnapshot.connected, installSnapshot.displayState, page, returnToCheck])

  const check = useCallback(() => {
    setOfferedReleaseTransition(null)
    setCompletedReleaseTransition(null)
    setCompletedChangelogs([])
    setPage("check")
    setCheckState("checking")
    setCheckGeneration((generation) => generation + 1)
  }, [])

  const install = useCallback(() => {
    if (installActionPendingRef.current || page !== "check") return
    const result = selectedCheckResultRef.current
    if (!result) {
      setErrorKind("network")
      setCheckState("error")
      return
    }
    const snapshot = ota.snapshot()
    if (!snapshot.wifiStatusKnown) {
      check()
      return
    }
    if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1) {
      onOpenWifiSetupRef.current?.()
      return
    }
    ota.installSession.prepare(result)
    setCompletedChangelogs([])
    if (updateFingerprint) {
      const fromVersion = offeredReleaseTransition
        ? offeredReleaseTransition.fromVersion
        : currentReleaseVersion(snapshot.appVersion)
      beginOtaAutoChain(updateFingerprint, isVersionChange, {
        fromVersion,
        toVersion: releaseRangeTargetVersion(result),
        releaseVersion: result.releaseVersion,
      })
    }
    navigateToProgress()
  }, [check, isVersionChange, navigateToProgress, offeredReleaseTransition, page, updateFingerprint])

  const retryInstall = useCallback(() => {
    if (page !== "progress") return
    onFirmwareRestartingChangeRef.current?.(false, true)
    ota.installSession.retry()
  }, [page])

  const finish = useCallback(async () => {
    if (page === "check") {
      onFinishedRef.current?.()
      return
    }
    if (installSnapshot.displayState === "restarting") stopOtaAutoChain()
    const requiresGlassesReboot = shouldRequireGlassesRebootForBesFailure(
      installSnapshot.otaStatus,
      installSnapshot.otaProgress,
      installSnapshot.errorMsg,
    )
    if (requiresGlassesReboot) stopOtaAutoChain()
    await ota.installSession.finish()
    returnToCheck()
  }, [installSnapshot, page, returnToCheck])

  const discard = useCallback(async () => {
    if (page !== "progress") return
    stopOtaAutoChain()
    await ota.installSession.discard()
    returnToCheck()
  }, [page, returnToCheck])

  const openWifiSetup = useCallback(() => {
    if (page === "progress") stopOtaAutoChain()
    onOpenWifiSetupRef.current?.()
  }, [page])

  const state = useMemo<MentraLiveOtaState>(() => {
    const hotspotSupported = otaSnapshot.hotspotOtaVersion === 1
    const canInstall = otaSnapshot.wifiStatusKnown && (otaSnapshot.wifiConnected || hotspotSupported)
    const autoChainActive = isOtaAutoChainActive()
    if (!runtimeReady) {
      return {
        screen: "initializing",
        connected: otaSnapshot.connected,
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
        releaseTransition: null,
        changelogs: [],
      }
    }

    if (page === "check") {
      const wifiRequired = otaSnapshot.wifiStatusKnown && !otaSnapshot.wifiConnected && !hotspotSupported
      let screen: MentraLiveOtaScreen
      if (checkState === "checking") screen = autoChainActive ? "finishing" : "checking"
      else if (checkState === "update_available") screen = wifiRequired ? "wifi_required" : "update_available"
      else if (checkState === "no_update") screen = "up_to_date"
      else if (checkState === "dev_build") screen = "dev_build"
      else screen = errorKind === "pin_unavailable" ? "update_info_unavailable" : "check_failed"

      let error: MentraLiveOtaError | null = null
      if (screen === "check_failed") {
        error = {
          code: "check_failed",
          message: "Couldn't check for updates. Please check your connection and try again.",
        }
      } else if (screen === "update_info_unavailable") {
        error = {code: "update_info_unavailable", message: "Update information for this app version is unavailable."}
      }
      return {
        screen,
        connected: otaSnapshot.connected,
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
        canFinish: screen === "up_to_date" || screen === "dev_build" || screen === "update_info_unavailable",
        canDismiss:
          (screen === "update_available" || screen === "wifi_required") && !isUpdateRequired && !autoChainActive,
        canDiscard: false,
        canOpenWifiSetup: screen === "wifi_required",
        continueDisabled: false,
        releaseTransition:
          screen === "update_available" || screen === "wifi_required"
            ? autoChainActive
              ? releaseTransitionFromRange(otaAutoChainReleaseRange())
              : offeredReleaseTransition
            : screen === "up_to_date"
              ? completedReleaseTransition
              : null,
        changelogs: screen === "up_to_date" ? completedChangelogs : [],
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
    const displayedError = requiresGlassesReboot
      ? BES_INSTALL_RESTART_MESSAGE
      : installSnapshot.errorMsg || getOtaErrorMessage(installSnapshot.otaStatus?.error)
    const progressState = progressScreen(installSnapshot)
    const screen = progressState === "complete" && autoChainActive ? "finishing" : progressState
    const error =
      screen === "failed"
        ? {
            code: requiresGlassesReboot ? ("bes_restart_required" as const) : ("install_failed" as const),
            message: displayedError,
          }
        : null
    const totalSteps = installSnapshot.otaStatus?.totalSteps ?? null
    const changelogs = screen === "complete" ? releaseChangelogsForActiveChain() : []
    return {
      screen,
      connected: installSnapshot.connected,
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
      canRetry: screen === "failed" && !requiresGlassesReboot,
      canFinish: screen === "complete" || screen === "restarting" || (screen === "failed" && requiresGlassesReboot),
      canDismiss: false,
      canDiscard: screen === "disconnected",
      canOpenWifiSetup: screen === "failed" && showChangeWifi,
      continueDisabled: installSnapshot.continueButtonDisabled,
      releaseTransition: releaseTransitionFromRange(otaAutoChainReleaseRange()),
      changelogs,
    }
  }, [
    checkState,
    completedChangelogs,
    completedReleaseTransition,
    errorKind,
    firmwareRestarting,
    installSnapshot,
    isUpdateRequired,
    isVersionChange,
    otaSnapshot,
    offeredReleaseTransition,
    page,
    runtimeReady,
  ])

  return useMemo(
    () => ({state, check, retryCheck: check, install, retryInstall, finish, discard, openWifiSetup}),
    [check, discard, finish, install, openWifiSetup, retryInstall, state],
  )
}
