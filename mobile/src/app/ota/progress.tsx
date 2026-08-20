import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {useCallback, useEffect, useRef} from "react"
import {View, ActivityIndicator} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {
  BES_INSTALL_RESTART_MESSAGE,
  getOtaErrorMessage,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "@/utils/otaErrorMapping"
import {useNavigationStore} from "@/stores/navigation"
import {isOtaAutoChainActive, stopOtaAutoChain} from "@/services/otaAutoChain"

const AUTO_CHAIN_COMPLETE_DELAY_MS = 750

/**
 * Pure renderer over the island OTA install state machine
 * (`engine.ota.installSession` / OtaInstallCoordinator). Every timer, retry,
 * reconnect and watchdog rule lives in island; this screen only attaches the
 * machine for its lifetime, renders the snapshot, and owns navigation.
 */
export default function OtaProgressScreen() {
  const {theme} = useAppTheme()
  const {replace, push} = useNavigationStore.getState()
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const install = useEngineSnapshot(engine.ota.installSession.snapshot, engine.ota.installSession.onSnapshot)
  const {
    displayState,
    errorMsg,
    continueButtonDisabled,
    connected,
    otaStatus,
    otaProgress,
    mtkInstallStallSimulatedPercent,
    isVersionChange,
    versionChangeConverged,
    versionChangePhase,
  } = install
  const autoChainAdvancedRef = useRef(false)

  focusEffectPreventBack()

  const isFirmwareCompleting = (!connected && displayState === "restarting") || versionChangePhase === "restarting"

  const {setConfig, clearConfig} = useConnectionOverlayConfig()
  useEffect(() => {
    if (isFirmwareCompleting) {
      setConfig({
        customTitle: "Please wait while Mentra Live restarts and automatically reconnects...",
        customMessage: "",
        hideStopButton: true,
        smallTitle: true,
        suppressOverlay: false,
      })
    } else {
      setConfig({suppressOverlay: true})
    }
    return () => clearConfig()
  }, [isFirmwareCompleting, setConfig, clearConfig])

  // The install state machine runs for exactly the screen's lifetime.
  useEffect(() => {
    engine.ota.installSession.attach()
    return () => {
      engine.ota.installSession.detach()
    }
  }, [])

  // A verified completion is the safe boundary between manifest generations.
  // Wait through any final reboot, keep success visible briefly, then re-enter
  // the checker; it either starts the next pass or presents the final state.
  useEffect(() => {
    if (displayState !== "complete" || !connected || !isOtaAutoChainActive() || autoChainAdvancedRef.current) return

    const timeout = setTimeout(() => {
      if (!isOtaAutoChainActive()) return
      autoChainAdvancedRef.current = true
      engine.ota.installSession.finish()
      replace("/ota/check-for-updates")
    }, AUTO_CHAIN_COMPLETE_DELAY_MS)

    return () => clearTimeout(timeout)
  }, [connected, displayState, replace])

  const handleContinue = () => {
    // This is the explicit BES recovery escape hatch shown before reboot
    // verification completes. Returning early must not preserve automation.
    stopOtaAutoChain()
    engine.ota.installSession.finish()
    replace("/ota/check-for-updates")
  }

  const handleRetry = () => {
    engine.ota.installSession.retry()
  }

  const handleDone = () => {
    engine.ota.installSession.finish()
    replace("/ota/check-for-updates")
  }

  const handleChangeWifi = useCallback(() => {
    stopOtaAutoChain()
    push("/wifi/scan")
  }, [push])

  const handleSkipSuper = useCallback(() => {
    stopOtaAutoChain()
    engine.ota.installSession.discard()
    replace("/ota/check-for-updates")
  }, [replace])

  const handleFailureDone = () => {
    stopOtaAutoChain()
    handleDone()
  }

  const renderContent = () => {
    // Downgrade detour: the recovery worker owns the transaction while ASG is being
    // replaced, so no progress events arrive during this window. Narrate the stages
    // and set duration expectations instead of showing a dead progress bar. Completion
    // (displayState === "complete") falls through to the shared complete branch below.
    if (versionChangePhase === "restarting" || versionChangePhase === "verifying") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text
            tx={versionChangePhase === "verifying" ? "ota:versionChangeVerifying" : "ota:versionChangeRestarting"}
            className="font-semibold text-xl text-center"
          />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text
            tx="ota:versionChangeKeepNearby"
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
          <View className="h-2" />
          <Text tx="ota:downgradeDuration" className="text-sm text-center" style={{color: theme.colors.textDim}} />
        </View>
      )
    }

    if (displayState === "starting") {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text text="Starting update..." className="font-semibold text-xl text-center" />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <View className="h-4" />
          <Text
            text="Do not disconnect your glasses"
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
        </View>
      )
    }

    if (displayState === "updating") {
      const isDownload = otaStatus?.phase === "download"
      const totalSteps = otaStatus?.totalSteps ?? 1
      const isApkOnlyInstalling = otaStatus?.stepType === "apk" && otaStatus?.phase === "install" && totalSteps === 1

      const rawPercent = isDownload
        ? (otaStatus?.stepPercent ?? 0)
        : totalSteps >= 2
          ? (otaStatus?.overallPercent ?? 0)
          : (otaStatus?.stepPercent ?? 0)
      // Legacy (< 37) MTK install stall simulation (WP 8C-e): the coordinator projects a
      // display-only percent while the MTK system install goes quiet; render whichever is
      // further along. Null for unified sessions and outside legacy MTK installs.
      const percent = Math.min(Math.max(rawPercent, mtkInstallStallSimulatedPercent ?? 0, 0), 100)

      return (
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="world-download" size={64} color={theme.colors.primary} />
          <View className="h-6" />
          <Text
            text={otaStatus?.phase === "download" ? "Downloading..." : "Installing..."}
            className="font-semibold text-xl text-center"
          />
          <View className="h-4" />
          {isApkOnlyInstalling ? (
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          ) : (
            <>
              <Text
                text={`${Math.round(percent)}%`}
                className="text-3xl font-bold"
                style={{color: theme.colors.primary}}
              />
              <View className="h-4" />
              <View className="w-full h-2 rounded-full overflow-hidden" style={{backgroundColor: theme.colors.border}}>
                <View
                  className="h-full rounded-full"
                  style={{backgroundColor: theme.colors.primary, width: `${percent}%`}}
                />
              </View>
            </>
          )}
          <View className="h-4" />
          <Text
            text="Do not disconnect your glasses"
            className="text-sm text-center"
            style={{color: theme.colors.textDim}}
          />
          {isVersionChange && otaStatus?.phase === "install" && (
            <>
              <View className="h-2" />
              <Text tx="ota:downgradeDuration" className="text-sm text-center" style={{color: theme.colors.textDim}} />
            </>
          )}
        </View>
      )
    }

    if (displayState === "restarting") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text="Update Installed" className="font-semibold text-xl text-center" />
          </View>
          <View className="justify-center items-center">
            <Button
              preset="primary"
              text="Continue"
              flexContainer
              onPress={handleContinue}
              disabled={continueButtonDisabled}
            />
          </View>
        </>
      )
    }

    if (displayState === "complete") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text
              tx={
                versionChangeConverged
                  ? "ota:versionChangeComplete"
                  : isVersionChange
                    ? "ota:versionChangeFirmwarePassComplete"
                    : undefined
              }
              text={versionChangeConverged || isVersionChange ? undefined : "Update complete!"}
              className="font-semibold text-xl text-center"
            />
            <View className="h-2" />
            <Text
              // A complete inside a version-change session that has NOT converged is the
              // firmware-first pass: firmware installed, the APK downgrade still pending. Saying
              // "up to date" here would be false — name the state and point at the next step.
              tx={
                versionChangeConverged
                  ? "ota:versionChangeCompleteMessage"
                  : isVersionChange
                    ? "ota:versionChangeFirmwarePassCompleteMessage"
                    : undefined
              }
              text={versionChangeConverged || isVersionChange ? undefined : "Your glasses are up to date."}
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>
          <View className="justify-center items-center">
            <Button
              preset="primary"
              text={isVersionChange && !versionChangeConverged ? "Continue" : "Done"}
              flexContainer
              onPress={handleDone}
            />
          </View>
        </>
      )
    }

    if (displayState === "failed") {
      const requiresGlassesReboot = shouldRequireGlassesRebootForBesFailure(otaStatus, otaProgress, errorMsg)
      const displayedError = requiresGlassesReboot
        ? BES_INSTALL_RESTART_MESSAGE
        : errorMsg || getOtaErrorMessage(otaStatus?.error)
      const showChangeWifi = shouldShowChangeWifiForOtaDownloadFailure(otaStatus, otaProgress, errorMsg)
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="alert" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text text="Update Failed" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text text={displayedError} className="text-sm text-center text-secondary-foreground" />
          </View>
          <View className="gap-3">
            {requiresGlassesReboot ? (
              <Button preset="primary" text="Done" flexContainer onPress={handleFailureDone} />
            ) : (
              <Button preset="primary" text="Retry" flexContainer onPress={handleRetry} />
            )}
            {showChangeWifi ? (
              <Button preset="secondary" text="Change WiFi" flexContainer onPress={handleChangeWifi} />
            ) : null}
          </View>
        </>
      )
    }

    return (
      <>
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="bluetooth-off" size={64} color={theme.colors.error} />
          <View className="h-6" />
          <Text text="Glasses disconnected" className="font-semibold text-xl text-center" />
          <View className="h-2" />
          <Text text="Reconnecting..." className="text-sm text-center" style={{color: theme.colors.textDim}} />
          <View className="h-4" />
          <ActivityIndicator size="large" color={theme.colors.foreground} />
        </View>
        {superMode ? (
          <View className="gap-3">
            <Button preset="secondary" text="Skip (super)" flexContainer onPress={handleSkipSuper} />
          </View>
        ) : null}
      </>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <Header RightActionComponent={<MentraLogoStandalone />} />
      {renderContent()}
    </Screen>
  )
}
