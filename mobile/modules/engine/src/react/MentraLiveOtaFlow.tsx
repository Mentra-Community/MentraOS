import React, {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import Svg, {Path, Rect} from "react-native-svg"

import {ota} from "../facades/ota"
import {
  beginOtaAutoChain,
  clearOtaAutoChainReconnectWait,
  isOtaAutoChainActive,
  otaAutoChainFingerprint,
  otaAutoChainReconnectWaitRemaining,
  stopOtaAutoChain,
  tryAdvanceOtaAutoChain,
} from "../services/OtaAutoChain"
import {
  BES_INSTALL_RESTART_MESSAGE,
  getOtaErrorMessage,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "../services/OtaErrorMapping"
import {useEngineSnapshot} from "./useEngineSnapshot"

export type MentraLiveOtaFlowPage = "check" | "progress"

export type MentraLiveOtaFlowTheme = {
  background: string
  border: string
  error: string
  foreground: string
  primary: string
  primaryText: string
  textDim: string
}

export type MentraLiveOtaFlowTranslate = (key: string, options?: Record<string, string>) => string

export type MentraLiveOtaFlowProps = {
  /** Display name used in update copy. */
  deviceName?: string
  /** Entry page. `progress` exists for recovery/deep-link compatibility. */
  initialPage?: MentraLiveOtaFlowPage
  /** Start the OTA-only projections. Full engine hosts should pass false. */
  initializeRuntime?: boolean
  /** Called after the final check or when the user leaves an optional update. */
  onFinished: () => void
  /** Host-owned Wi-Fi setup for glasses that do not support hotspot OTA. */
  onOpenWifiSetup: () => void
  /** Lets a host coordinate its global connection overlay with OTA progress and firmware restarts. */
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
  /** Enables the existing developer-only escape hatches. */
  allowDevSkip?: boolean
  /** Enables the existing super-mode interrupted-session escape hatch. */
  superMode?: boolean
  /** Optional host localization. Defaults to the Mentra App English OTA copy. */
  translate?: MentraLiveOtaFlowTranslate
  /** Optional host theme. Both hosts use the same layout and state machine. */
  theme?: Partial<MentraLiveOtaFlowTheme>
  style?: StyleProp<ViewStyle>
}

type CheckState = "checking" | "update_available" | "no_update" | "dev_build" | "error"

const AUTO_CHAIN_NETWORK_RETRY_DELAY_MS = 5000
const AUTO_CHAIN_COMPLETE_DELAY_MS = 750

const DEFAULT_THEME: MentraLiveOtaFlowTheme = {
  background: "#FFFFFF",
  border: "#D7DFDA",
  error: "#C43131",
  foreground: "#0E2C1A",
  primary: "#00B869",
  primaryText: "#FFFFFF",
  textDim: "#66736B",
}

const ENGLISH_COPY: Record<string, string> = {
  "common:continue": "Continue",
  "ota:checkingForUpdates": "Checking for updates",
  "ota:checkingForUpdatesMessage":
    "Connected devices will perform automatic updates. Automatic updates can be disabled in Device Settings",
  "ota:updateAvailable": "{{deviceName}} Update Available",
  "ota:updateConnectWifi": "Connect your {{deviceName}} to WiFi to install the update.",
  "ota:updateDescription":
    "A new update is available for your glasses. We recommend updating now for the best experience.",
  "ota:downgradeAvailable": "{{deviceName}} Version Change Required",
  "ota:downgradeDescription":
    "This app requires an earlier glasses software version. Your photos and videos will be preserved, but glasses settings will be reset and restored automatically after the change.",
  "ota:updateNow": "Update Now",
  "ota:setupWifi": "Setup WiFi",
  "ota:updateLater": "Later",
  "ota:upToDate": "Up To Date",
  "ota:devBuild": "Development Build",
  "ota:devBuildNoOta":
    "This mobile app is a development build, so automatic glasses updates are disabled. Use the developer settings manifest override to update them manually.",
  "ota:noUpdatesAvailable": "Your glasses are running the latest version.",
  "ota:checkFailed": "Check Failed",
  "ota:checkFailedMessage": "Couldn't check for updates. Please check your connection and try again.",
  "ota:updateInfoUnavailable": "Update Info Unavailable",
  "ota:updateInfoUnavailableMessage":
    "Update information for this version of the app is unavailable. Please check the app store for a newer version of the Mentra App.",
  "ota:downgradeDuration": "Your glasses will restart twice — this may take up to 2 minutes.",
  "ota:versionChangeRestarting": "Installing a different version…",
  "ota:versionChangeVerifying": "Verifying your glasses…",
  "ota:versionChangeKeepNearby": "Keep your glasses nearby and connected. They will restart on their own.",
  "ota:versionChangeComplete": "Version Change Complete",
  "ota:versionChangeCompleteMessage":
    "Your glasses are now on the required version. Their settings were reset and are being restored automatically.",
  "ota:versionChangeFirmwarePassComplete": "Firmware updated",
  "ota:versionChangeFirmwarePassCompleteMessage":
    "Your glasses restarted with new firmware. One more step: they'll now continue to the required version.",
}

function defaultTranslate(key: string, options?: Record<string, string>): string {
  let value = ENGLISH_COPY[key] ?? key
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.replaceAll(`{{${name}}}`, replacement)
  }
  return value
}

export function MentraLiveOtaFlow({
  allowDevSkip = typeof __DEV__ !== "undefined" && __DEV__,
  deviceName = "Mentra Live",
  initialPage = "check",
  initializeRuntime = true,
  onFinished,
  onFirmwareRestartingChange,
  onOpenWifiSetup,
  style,
  superMode = false,
  theme,
  translate = defaultTranslate,
}: MentraLiveOtaFlowProps) {
  const colors = useMemo(() => ({...DEFAULT_THEME, ...theme}), [theme])
  const [page, setPage] = useState<MentraLiveOtaFlowPage>(initialPage)
  const [checkGeneration, setCheckGeneration] = useState(0)
  const [runtimeReady, setRuntimeReady] = useState(!initializeRuntime)

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

  const showCheck = useCallback(() => {
    setPage("check")
    setCheckGeneration((generation) => generation + 1)
  }, [])

  return (
    <SafeAreaView style={[styles.safeArea, {backgroundColor: colors.background}, style]}>
      <View style={styles.header}>
        <View />
        <MentraMark color={colors.primary} />
      </View>
      {!runtimeReady ? (
        <FlowPage colors={colors} icon="download" title={translate("ota:checkingForUpdates")}>
          <ActivityIndicator size="large" color={colors.foreground} />
        </FlowPage>
      ) : page === "check" ? (
        <OtaCheckPage
          allowDevSkip={allowDevSkip}
          colors={colors}
          deviceName={deviceName}
          generation={checkGeneration}
          onFinished={onFinished}
          onOpenWifiSetup={onOpenWifiSetup}
          onStartProgress={() => setPage("progress")}
          translate={translate}
        />
      ) : (
        <OtaProgressPage
          colors={colors}
          onFirmwareRestartingChange={onFirmwareRestartingChange}
          onOpenWifiSetup={onOpenWifiSetup}
          onReturnToCheck={showCheck}
          superMode={superMode}
          translate={translate}
        />
      )}
    </SafeAreaView>
  )
}

type CheckPageProps = {
  allowDevSkip: boolean
  colors: MentraLiveOtaFlowTheme
  deviceName: string
  generation: number
  onFinished: () => void
  onOpenWifiSetup: () => void
  onStartProgress: () => void
  translate: MentraLiveOtaFlowTranslate
}

function OtaCheckPage({
  allowDevSkip,
  colors,
  deviceName,
  generation,
  onFinished,
  onOpenWifiSetup,
  onStartProgress,
  translate,
}: CheckPageProps) {
  const otaSnapshot = useEngineSnapshot(ota.snapshot, ota.onSnapshot)
  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [isUpdateRequired, setIsUpdateRequired] = useState(true)
  const [isDowngradeUpdate, setIsDowngradeUpdate] = useState(false)
  const [errorKind, setErrorKind] = useState<"network" | "pin_unavailable">("network")
  const [updateFingerprint, setUpdateFingerprint] = useState<string | null>(null)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const performCheckGenerationRef = useRef(0)
  const activeCheckKeyRef = useRef<string | null>(null)
  const checkStartedRef = useRef(false)
  const checkCompletedRef = useRef(false)
  const selectedCheckResultRef = useRef<Awaited<ReturnType<typeof ota.checkForUpdates>> | null>(null)
  const onFinishedRef = useRef(onFinished)
  const onStartProgressRef = useRef(onStartProgress)
  onFinishedRef.current = onFinished
  onStartProgressRef.current = onStartProgress

  const glassesWifiConnected = otaSnapshot.wifiConnected
  const glassesWifiStatusKnown = otaSnapshot.wifiStatusKnown
  const hotspotOtaSupported = otaSnapshot.hotspotOtaVersion === 1
  const canInstallUpdate = glassesWifiStatusKnown && (glassesWifiConnected || hotspotOtaSupported)
  const checkKey = `${generation}:${retryGeneration}`

  const navigateToProgress = useCallback(() => {
    ota.clearProgress()
    onStartProgressRef.current()
  }, [])

  useEffect(() => {
    const MIN_DISPLAY_TIME_MS = 1100
    const MAX_WAIT_FOR_VERSION_INFO_MS = 10_000
    if (activeCheckKeyRef.current !== checkKey) {
      activeCheckKeyRef.current = checkKey
      checkStartedRef.current = false
      checkCompletedRef.current = false
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
        onFinishedRef.current()
        return
      }

      clearOtaAutoChainReconnectWait()
      checkStartedRef.current = true
      const startTime = Date.now()
      try {
        let result = await ota.checkForUpdates({
          waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
          waitForBesVersionMs: 5000,
          waitForMtkVersionMs: 2000,
          refreshVersionInfo: true,
          fixClockBeforeCheck: false,
        })
        if (cancelled || myGeneration !== performCheckGenerationRef.current) return
        if (!result.hasCheckCompleted && result.checkFailureReason === "network" && isOtaAutoChainActive()) {
          await new Promise((resolve) => setTimeout(resolve, AUTO_CHAIN_NETWORK_RETRY_DELAY_MS))
          if (cancelled || myGeneration !== performCheckGenerationRef.current) return
          result = await ota.checkForUpdates({
            waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
            waitForBesVersionMs: 5000,
            waitForMtkVersionMs: 2000,
            refreshVersionInfo: true,
            fixClockBeforeCheck: false,
          })
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
            onFinishedRef.current()
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
          setIsDowngradeUpdate(result.updateInfo.isDowngrade === true)
          const fingerprint = otaAutoChainFingerprint(result)
          setUpdateFingerprint(fingerprint)
          if (isOtaAutoChainActive()) {
            const snapshot = ota.snapshot()
            if (!snapshot.wifiStatusKnown) return
            if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1) {
              stopOtaAutoChain()
            } else {
              const admission = tryAdvanceOtaAutoChain(fingerprint, result.updateInfo.isDowngrade === true)
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
        setCheckState("error")
      }
    }

    void performCheck()
    return () => {
      cancelled = true
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }
  }, [
    checkKey,
    otaSnapshot.connected,
    otaSnapshot.wifiStatusKnown,
    navigateToProgress,
  ])

  const retry = () => {
    setCheckState("checking")
    setRetryGeneration((value) => value + 1)
  }

  const updateNow = () => {
    const result = selectedCheckResultRef.current
    if (!result) {
      setCheckState("error")
      return
    }
    const snapshot = ota.snapshot()
    if (!snapshot.wifiStatusKnown) {
      retry()
      return
    }
    if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1) {
      onOpenWifiSetup()
      return
    }
    ota.installSession.prepare(result)
    if (updateFingerprint) beginOtaAutoChain(updateFingerprint, isDowngradeUpdate)
    navigateToProgress()
  }

  if (checkState === "checking") {
    return (
      <FlowPage colors={colors} icon="download" title={translate("ota:checkingForUpdates")}>
        <BodyText colors={colors}>{translate("ota:checkingForUpdatesMessage")}</BodyText>
        <ActivityIndicator size="large" color={colors.foreground} />
      </FlowPage>
    )
  }

  if (checkState === "update_available") {
    return (
      <FlowPage
        colors={colors}
        icon="download"
        title={translate(isDowngradeUpdate ? "ota:downgradeAvailable" : "ota:updateAvailable", {deviceName})}
        actions={
          <>
            <FlowButton
              colors={colors}
              disabled={!glassesWifiStatusKnown}
              label={translate(!glassesWifiStatusKnown || canInstallUpdate ? "ota:updateNow" : "ota:setupWifi")}
              onPress={updateNow}
            />
            {!isUpdateRequired ? (
              <FlowButton colors={colors} label={translate("ota:updateLater")} onPress={onFinished} secondary />
            ) : null}
            {allowDevSkip && isUpdateRequired ? (
              <FlowButton colors={colors} label="Skip (dev only)" onPress={onFinished} secondary />
            ) : null}
          </>
        }>
        <BodyText colors={colors}>
          {canInstallUpdate
            ? translate(isDowngradeUpdate ? "ota:downgradeDescription" : "ota:updateDescription")
            : translate("ota:updateConnectWifi", {deviceName})}
        </BodyText>
      </FlowPage>
    )
  }

  if (checkState === "dev_build") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={onFinished} />}
        colors={colors}
        icon="settings"
        title={translate("ota:devBuild")}>
        <BodyText colors={colors}>{translate("ota:devBuildNoOta")}</BodyText>
      </FlowPage>
    )
  }

  if (checkState === "no_update") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={onFinished} />}
        colors={colors}
        icon="check"
        title={translate("ota:upToDate")}>
        <BodyText colors={colors}>{translate("ota:noUpdatesAvailable")}</BodyText>
      </FlowPage>
    )
  }

  if (errorKind === "pin_unavailable") {
    return (
      <FlowPage
        actions={<FlowButton colors={colors} label={translate("common:continue")} onPress={onFinished} />}
        colors={colors}
        icon="alert"
        title={translate("ota:updateInfoUnavailable")}>
        <BodyText colors={colors}>{translate("ota:updateInfoUnavailableMessage")}</BodyText>
      </FlowPage>
    )
  }

  return (
    <FlowPage
      actions={
        <>
          <FlowButton colors={colors} label="Retry" onPress={retry} />
          {allowDevSkip ? <FlowButton colors={colors} label="Skip (dev only)" onPress={onFinished} secondary /> : null}
        </>
      }
      colors={colors}
      icon="alert"
      title={translate("ota:checkFailed")}>
      <BodyText colors={colors}>{translate("ota:checkFailedMessage")}</BodyText>
    </FlowPage>
  )
}

type ProgressPageProps = {
  colors: MentraLiveOtaFlowTheme
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
  onOpenWifiSetup: () => void
  onReturnToCheck: () => void
  superMode: boolean
  translate: MentraLiveOtaFlowTranslate
}

function OtaProgressPage({
  colors,
  onFirmwareRestartingChange,
  onOpenWifiSetup,
  onReturnToCheck,
  superMode,
  translate,
}: ProgressPageProps) {
  const install = useEngineSnapshot(ota.installSession.snapshot, ota.installSession.onSnapshot)
  const autoChainAdvancedRef = useRef(false)
  const {
    connected,
    continueButtonDisabled,
    displayState,
    errorMsg,
    hotspotArtifactPercent,
    hotspotPhase,
    isVersionChange,
    mtkInstallStallSimulatedPercent,
    otaProgress,
    otaStatus,
    versionChangeConverged,
    versionChangePhase,
  } = install
  const firmwareRestarting = (!connected && displayState === "restarting") || versionChangePhase === "restarting"

  useEffect(() => {
    onFirmwareRestartingChange?.(firmwareRestarting, true)
  }, [firmwareRestarting, onFirmwareRestartingChange])

  useEffect(
    () => () => {
      onFirmwareRestartingChange?.(false, false)
    },
    [onFirmwareRestartingChange],
  )

  useEffect(() => {
    ota.installSession.attach()
    return () => ota.installSession.detach()
  }, [])

  useEffect(() => {
    if (displayState !== "complete" || !connected || !isOtaAutoChainActive() || autoChainAdvancedRef.current) return
    const timeout = setTimeout(() => {
      if (!isOtaAutoChainActive()) return
      autoChainAdvancedRef.current = true
      ota.installSession.finish()
      onReturnToCheck()
    }, AUTO_CHAIN_COMPLETE_DELAY_MS)
    return () => clearTimeout(timeout)
  }, [connected, displayState, onReturnToCheck])

  const finishAndCheck = () => {
    ota.installSession.finish()
    onReturnToCheck()
  }
  const stopAndCheck = () => {
    stopOtaAutoChain()
    finishAndCheck()
  }
  const retryInstall = () => {
    onFirmwareRestartingChange?.(false, true)
    ota.installSession.retry()
  }

  if (versionChangePhase === "restarting" || versionChangePhase === "verifying") {
    return (
      <FlowPage
        colors={colors}
        icon="download"
        title={translate(
          versionChangePhase === "verifying" ? "ota:versionChangeVerifying" : "ota:versionChangeRestarting",
        )}>
        <ActivityIndicator size="large" color={colors.foreground} />
        <BodyText colors={colors}>{translate("ota:versionChangeKeepNearby")}</BodyText>
        <BodyText colors={colors}>{translate("ota:downgradeDuration")}</BodyText>
      </FlowPage>
    )
  }

  if (displayState === "starting") {
    const hotspotTitle =
      hotspotPhase === "downloading"
        ? "Downloading update to phone..."
        : hotspotPhase === "starting_hotspot"
        ? "Starting glasses hotspot..."
        : hotspotPhase === "joining_hotspot"
        ? "Connecting phone to glasses..."
        : "Starting update..."
    return (
      <FlowPage colors={colors} icon="download" title={hotspotTitle}>
        {hotspotPhase === "downloading" && hotspotArtifactPercent !== null ? (
          <PercentText colors={colors} percent={hotspotArtifactPercent} />
        ) : null}
        <ActivityIndicator size="large" color={colors.foreground} />
        <BodyText colors={colors}>Do not disconnect your glasses</BodyText>
      </FlowPage>
    )
  }

  if (displayState === "updating") {
    const isDownload = otaStatus?.phase === "download"
    const totalSteps = otaStatus?.totalSteps ?? 1
    const isApkOnlyInstalling = otaStatus?.stepType === "apk" && otaStatus.phase === "install" && totalSteps === 1
    const rawPercent = isDownload
      ? otaStatus?.stepPercent ?? 0
      : totalSteps >= 2
      ? otaStatus?.overallPercent ?? 0
      : otaStatus?.stepPercent ?? 0
    const percent = Math.min(Math.max(rawPercent, mtkInstallStallSimulatedPercent ?? 0, 0), 100)
    return (
      <FlowPage colors={colors} icon="download" title={isDownload ? "Downloading..." : "Installing..."}>
        {isApkOnlyInstalling ? (
          <ActivityIndicator size="large" color={colors.foreground} />
        ) : (
          <>
            <PercentText colors={colors} percent={percent} />
            <View style={[styles.progressTrack, {backgroundColor: colors.border}]}>
              <View style={[styles.progressFill, {backgroundColor: colors.primary, width: `${percent}%`}]} />
            </View>
          </>
        )}
        <BodyText colors={colors}>Do not disconnect your glasses</BodyText>
        {isVersionChange && otaStatus?.phase === "install" ? (
          <BodyText colors={colors}>{translate("ota:downgradeDuration")}</BodyText>
        ) : null}
      </FlowPage>
    )
  }

  if (displayState === "restarting") {
    return (
      <FlowPage
        actions={
          <FlowButton colors={colors} disabled={continueButtonDisabled} label="Continue" onPress={stopAndCheck} />
        }
        colors={colors}
        icon="check"
        title="Update Installed"
      />
    )
  }

  if (displayState === "complete") {
    const title = versionChangeConverged
      ? translate("ota:versionChangeComplete")
      : isVersionChange
      ? translate("ota:versionChangeFirmwarePassComplete")
      : "Update complete!"
    const message = versionChangeConverged
      ? translate("ota:versionChangeCompleteMessage")
      : isVersionChange
      ? translate("ota:versionChangeFirmwarePassCompleteMessage")
      : "Your glasses are up to date."
    return (
      <FlowPage
        actions={
          <FlowButton
            colors={colors}
            label={isVersionChange && !versionChangeConverged ? "Continue" : "Done"}
            onPress={finishAndCheck}
          />
        }
        colors={colors}
        icon="check"
        title={title}>
        <BodyText colors={colors}>{message}</BodyText>
      </FlowPage>
    )
  }

  if (displayState === "failed") {
    const requiresGlassesReboot = shouldRequireGlassesRebootForBesFailure(otaStatus, otaProgress, errorMsg)
    const displayedError = requiresGlassesReboot
      ? BES_INSTALL_RESTART_MESSAGE
      : errorMsg || getOtaErrorMessage(otaStatus?.error)
    const showChangeWifi = shouldShowChangeWifiForOtaDownloadFailure(otaStatus, otaProgress, errorMsg)
    return (
      <FlowPage
        actions={
          <>
            <FlowButton
              colors={colors}
              label={requiresGlassesReboot ? "Done" : "Retry"}
              onPress={requiresGlassesReboot ? stopAndCheck : retryInstall}
            />
            {showChangeWifi ? (
              <FlowButton
                colors={colors}
                label="Change WiFi"
                onPress={() => {
                  stopOtaAutoChain()
                  onOpenWifiSetup()
                }}
                secondary
              />
            ) : null}
          </>
        }
        colors={colors}
        icon="alert"
        title="Update Failed">
        <BodyText colors={colors}>{displayedError}</BodyText>
      </FlowPage>
    )
  }

  return (
    <FlowPage
      actions={
        superMode ? (
          <FlowButton
            colors={colors}
            label="Skip (super)"
            onPress={() => {
              stopOtaAutoChain()
              ota.installSession.discard()
              onReturnToCheck()
            }}
            secondary
          />
        ) : undefined
      }
      colors={colors}
      icon="bluetooth"
      title="Glasses disconnected">
      <BodyText colors={colors}>Reconnecting...</BodyText>
      <ActivityIndicator size="large" color={colors.foreground} />
    </FlowPage>
  )
}

type FlowPageProps = {
  actions?: React.ReactNode
  children?: React.ReactNode
  colors: MentraLiveOtaFlowTheme
  icon: "alert" | "bluetooth" | "check" | "download" | "settings"
  title: string
}

function FlowPage({actions, children, colors, icon, title}: FlowPageProps) {
  return (
    <View style={styles.page} testID="mentra-live-ota-flow">
      <View style={styles.centerContent}>
        <FlowIcon colors={colors} name={icon} />
        <Text style={[styles.title, {color: colors.foreground}]}>{title}</Text>
        {children}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : <View style={styles.actionSpacer} />}
    </View>
  )
}

function BodyText({children, colors}: {children: React.ReactNode; colors: MentraLiveOtaFlowTheme}) {
  return <Text style={[styles.body, {color: colors.textDim}]}>{children}</Text>
}

function PercentText({colors, percent}: {colors: MentraLiveOtaFlowTheme; percent: number}) {
  return <Text style={[styles.percent, {color: colors.primary}]}>{Math.round(percent)}%</Text>
}

function FlowButton({
  colors,
  disabled = false,
  label,
  onPress,
  secondary = false,
}: {
  colors: MentraLiveOtaFlowTheme
  disabled?: boolean
  label: string
  onPress: () => void
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: secondary ? colors.background : colors.primary,
          borderColor: secondary ? colors.border : colors.primary,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
      testID={`button-${label}`}>
      <Text style={[styles.buttonText, {color: secondary ? colors.foreground : colors.primaryText}]}>{label}</Text>
    </Pressable>
  )
}

function MentraMark({color}: {color: string}) {
  return (
    <Svg width={33} height={18} viewBox="0 0 50 27" fill="none">
      <Rect y={14.8072} width={11.8457} height={11.8457} fill={color} />
      <Path d="M9.36639 0L30.7163 14.8072V26.6529L9.36639 11.8457V0Z" fill={color} />
      <Path d="M28.6501 0L50 14.8072V26.6529L28.6501 11.8457V0Z" fill={color} />
    </Svg>
  )
}

function FlowIcon({colors, name}: {colors: MentraLiveOtaFlowTheme; name: FlowPageProps["icon"]}) {
  const color = name === "alert" || name === "bluetooth" ? colors.error : colors.primary
  const glyph =
    name === "check" ? "✓" : name === "alert" ? "!" : name === "settings" ? "⚙" : name === "bluetooth" ? "⌁" : "↓"
  return <Text style={[styles.icon, {color}]}>{glyph}</Text>
}

const styles = StyleSheet.create({
  safeArea: {flex: 1},
  header: {
    alignItems: "center",
    flexDirection: "row",
    height: 48,
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  page: {flex: 1, paddingBottom: 24, paddingHorizontal: 24},
  centerContent: {alignItems: "center", flex: 1, gap: 16, justifyContent: "center"},
  actionSpacer: {height: 48},
  actions: {gap: 12},
  icon: {fontSize: 64, fontWeight: "500", lineHeight: 72, textAlign: "center"},
  title: {fontSize: 20, fontWeight: "600", textAlign: "center"},
  body: {fontSize: 14, lineHeight: 20, maxWidth: 420, textAlign: "center"},
  percent: {fontSize: 30, fontVariant: ["tabular-nums"], fontWeight: "700"},
  progressTrack: {borderRadius: 4, height: 8, maxWidth: 420, overflow: "hidden", width: "100%"},
  progressFill: {borderRadius: 4, height: 8},
  button: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  buttonText: {fontSize: 15, fontWeight: "700"},
})
