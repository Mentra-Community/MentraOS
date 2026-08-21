import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {useFocusEffect} from "expo-router"
import {useEffect, useState, useCallback, useRef} from "react"
import {View, ActivityIndicator} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {
  beginOtaAutoChain,
  clearOtaAutoChainReconnectWait,
  isOtaAutoChainActive,
  otaAutoChainReconnectWaitRemaining,
  otaAutoChainFingerprint,
  stopOtaAutoChain,
  tryAdvanceOtaAutoChain,
} from "@/services/otaAutoChain"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"

type CheckState = "checking" | "update_available" | "no_update" | "dev_build" | "error"

// Android may need a few seconds to restore the default internet network after
// the scoped hotspot network is released. Retry once only while automatically
// chaining OTA passes; manual checks and non-network failures remain immediate.
const AUTO_CHAIN_NETWORK_RETRY_DELAY_MS = 5000

export default function OtaCheckForUpdatesScreen() {
  const {theme} = useAppTheme()
  const {replace, clearHistoryAndGoHome, push} = useNavigationStore.getState()
  const otaSnapshot = useEngineSnapshot(engine.ota.snapshot, engine.ota.onSnapshot)
  const currentBuildNumber = otaSnapshot.buildNumber
  const mtkFirmwareVersion = otaSnapshot.mtkFirmwareVersion
  const besFirmwareVersion = otaSnapshot.besFirmwareVersion
  const glassesWifiConnected = otaSnapshot.wifiConnected
  const hotspotOtaSupported = otaSnapshot.hotspotOtaVersion >= 1
  const canInstallUpdate = glassesWifiConnected || hotspotOtaSupported
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const deviceName = defaultWearable || "Glasses"
  const glassesConnected = otaSnapshot.connected
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)

  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [isUpdateRequired, setIsUpdateRequired] = useState(true) // Default to required if not specified
  const [isDowngradeUpdate, setIsDowngradeUpdate] = useState(false)
  /** Distinguishes retryable network trouble from a dead pin (remedy: update the app). */
  const [errorKind, setErrorKind] = useState<"network" | "pin_unavailable">("network")
  const [updateFingerprint, setUpdateFingerprint] = useState<string | null>(null)
  const [checkKey, setCheckKey] = useState(0)
  /** Incremented each effect run so stale async performCheck exits before mutating state. */
  const performCheckGenerationRef = useRef(0)
  const activeCheckKeyRef = useRef<number | null>(null)
  const checkStartedRef = useRef(false)
  const checkCompletedRef = useRef(false)
  const selectedCheckResultRef = useRef<Awaited<ReturnType<typeof engine.ota.checkForUpdates>> | null>(null)

  focusEffectPreventBack()

  const navigateToProgress = useCallback(() => {
    const otaProgressBefore = engine.ota.snapshot().legacyProgress
    console.log(
      "OTA_TRACK: navigate_to_progress",
      JSON.stringify({
        from: "check-for-updates",
        action: "clear_otaProgress_then_replace",
        otaProgressBefore: otaProgressBefore
          ? {
              currentUpdate: otaProgressBefore.currentUpdate,
              status: otaProgressBefore.status,
              stage: otaProgressBefore.stage,
            }
          : null,
      }),
    )
    engine.ota.clearProgress()
    replace("/ota/progress")
  }, [replace])

  // Re-run OTA check when screen gains focus (for iterative updates: APK → MTK → BES)
  useFocusEffect(
    useCallback(() => {
      console.log("OTA: Screen focused - triggering re-check")
      setCheckState("checking")
      setCheckKey((k) => k + 1)
    }, []),
  )

  // Perform OTA check when checkKey changes (on mount and on focus).
  useEffect(() => {
    const MIN_DISPLAY_TIME_MS = 1100
    const MAX_WAIT_FOR_VERSION_INFO_MS = 10000 // Wait up to 10 seconds for version_info
    if (activeCheckKeyRef.current !== checkKey) {
      activeCheckKeyRef.current = checkKey
      checkStartedRef.current = false
      checkCompletedRef.current = false
    }

    const myGen = ++performCheckGenerationRef.current
    let cancelled = false
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

    const performCheck = async () => {
      if (checkCompletedRef.current) {
        return
      }

      if (!glassesConnected) {
        if (isOtaAutoChainActive()) {
          const remainingMs = otaAutoChainReconnectWaitRemaining()
          if (remainingMs === null) return

          console.log(`OTA: Waiting up to ${remainingMs}ms for glasses to reconnect between chained passes`)
          reconnectTimeout = setTimeout(() => {
            if (cancelled || myGen !== performCheckGenerationRef.current || engine.ota.snapshot().connected) return

            console.log("OTA: Timed out waiting for glasses to reconnect during automatic update chain")
            stopOtaAutoChain()
            checkCompletedRef.current = true
            setCheckState("error")
          }, remainingMs)
          return
        }
        if (checkStartedRef.current) {
          console.log("OTA: Glasses disconnected after OTA check started - setting error state")
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setCheckState("error")
          return
        }
        console.log("OTA: Glasses not connected - proceeding to next step")
        checkCompletedRef.current = true
        handleContinue()
        return
      }

      clearOtaAutoChainReconnectWait()
      checkStartedRef.current = true
      const startTime = Date.now()

      try {
        console.log("OTA: Checking current glasses via engine OTA")
        let result = await engine.ota.checkForUpdates({
          waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
          waitForBesVersionMs: 5000,
          waitForMtkVersionMs: 2000,
          refreshVersionInfo: true,
          fixClockBeforeCheck: false,
        })
        if (cancelled || myGen !== performCheckGenerationRef.current) return

        if (!result.hasCheckCompleted && result.checkFailureReason === "network" && isOtaAutoChainActive()) {
          console.log(
            `OTA: Manifest check raced hotspot cleanup; retrying once in ${AUTO_CHAIN_NETWORK_RETRY_DELAY_MS}ms`,
          )
          await new Promise((resolve) => setTimeout(resolve, AUTO_CHAIN_NETWORK_RETRY_DELAY_MS))
          if (cancelled || myGen !== performCheckGenerationRef.current) return

          result = await engine.ota.checkForUpdates({
            waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
            waitForBesVersionMs: 5000,
            waitForMtkVersionMs: 2000,
            refreshVersionInfo: true,
            fixClockBeforeCheck: false,
          })
        }

        console.log(
          "📱 OTA check completed - result:",
          JSON.stringify({
            hasCheckCompleted: result.hasCheckCompleted,
            updateAvailable: result.updateAvailable,
            updates: result.updates,
            skippedReason: result.skippedReason,
            checkFailureReason: result.checkFailureReason,
          }),
        )
        selectedCheckResultRef.current = result

        // Calculate remaining time to meet minimum display duration
        const elapsed = Date.now() - startTime
        const remainingDelay = Math.max(0, MIN_DISPLAY_TIME_MS - elapsed)

        // Wait for minimum display time before showing result
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))

        if (cancelled || myGen !== performCheckGenerationRef.current) {
          return
        }

        if (result.skippedReason === "disconnected") {
          console.log("OTA: Check skipped after glasses disconnected - setting error state")
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setCheckState("error")
          return
        }

        if (result.skippedReason === "missing_build") {
          if (isOtaAutoChainActive()) {
            console.log("OTA: Missing build metadata during automatic update chain - stopping chain")
            stopOtaAutoChain()
            checkCompletedRef.current = true
            setCheckState("error")
            return
          }
          console.log("OTA: Check skipped (missing_build) - proceeding to next step")
          checkCompletedRef.current = true
          handleContinue()
          return
        }

        if (result.skippedReason === "dev_build") {
          // Locally built mobile apps are exempt from OTA. Shown as its own state — NOT
          // "up to date", which would be an unverified claim.
          console.log("OTA: Check skipped (dev_build) - mobile app is a development build")
          stopOtaAutoChain()
          checkCompletedRef.current = true
          engine.ota.clearUpdateAvailable()
          setCheckState("dev_build")
          return
        }

        if (!result.hasCheckCompleted) {
          console.log(`📱 OTA check did not complete (${result.checkFailureReason ?? "network"}) - setting error state`)
          stopOtaAutoChain()
          checkCompletedRef.current = true
          setErrorKind(result.checkFailureReason === "pin_unavailable" ? "pin_unavailable" : "network")
          setCheckState("error")
          return
        }

        if (result.updateAvailable && result.updateInfo) {
          console.log("📱 Updates available - setting update_available state")
          checkCompletedRef.current = true
          setIsUpdateRequired(result.isRequired)
          setIsDowngradeUpdate(result.updateInfo.isDowngrade === true)
          const fingerprint = otaAutoChainFingerprint(result)
          setUpdateFingerprint(fingerprint)

          if (isOtaAutoChainActive()) {
            const snapshot = engine.ota.snapshot()
            if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion < 1) {
              console.log("OTA: Automatic update chain paused because neither Wi-Fi nor hotspot OTA is available")
              stopOtaAutoChain()
            } else {
              const admission = tryAdvanceOtaAutoChain(fingerprint, result.updateInfo.isDowngrade === true)
              if (admission.advance) {
                console.log(`OTA: Automatically starting chained update pass ${admission.passCount}`)
                engine.ota.installSession.prepare(result)
                navigateToProgress()
                return
              }
              console.warn(`OTA: Automatic update chain stopped (${admission.reason})`)
            }
          }

          setCheckState("update_available")
        } else {
          console.log("📱 No updates available - setting no_update state")
          stopOtaAutoChain()
          checkCompletedRef.current = true
          engine.ota.clearUpdateAvailable()
          setCheckState("no_update")
        }
      } catch (error) {
        console.error("OTA check failed:", error)
        // Still respect minimum display time on error
        const elapsed = Date.now() - startTime
        const remainingDelay = Math.max(0, MIN_DISPLAY_TIME_MS - elapsed)
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))
        // Same stale-run guard as the success path: a superseded check (retry/
        // refocus bumped the generation, or the effect was cleaned up) must not
        // flip the current run into "error" or mark it completed.
        if (cancelled || myGen !== performCheckGenerationRef.current) {
          return
        }
        stopOtaAutoChain()
        checkCompletedRef.current = true
        setCheckState("error")
      }
    }

    performCheck()

    // Cleanup timeouts on unmount or when dependencies change
    return () => {
      cancelled = true
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, currentBuildNumber, mtkFirmwareVersion, besFirmwareVersion, glassesConnected, navigateToProgress])

  // Navigate to next step based on onboarding status
  const handleContinue = () => {
    stopOtaAutoChain()
    const nextRoute = getNextOnboardingRoute({
      includeMentraLive: true,
      onboardingLiveCompleted,
      onboardingOsCompleted,
    })
    console.log("OTA: handleContinue() - onboarding status:", {
      nextRoute,
      onboardingLiveCompleted,
      onboardingOsCompleted,
    })
    if (nextRoute) {
      // Replace so leaving onboarding returns home instead of returning to OTA.
      replace(nextRoute)
      return
    }
    console.log("OTA: Onboarding already completed - navigating home")
    clearHistoryAndGoHome()
  }

  // Retry OTA check
  const handleRetry = () => {
    console.log("OTA: handleRetry()")
    setCheckState("checking")
    setCheckKey((k) => k + 1)
  }

  const handleUpdateNow = () => {
    const result = selectedCheckResultRef.current
    if (!result) {
      console.warn("OTA: Update Now pressed without a selected check result")
      setCheckState("error")
      return
    }
    if (!engine.ota.snapshot().wifiConnected && !hotspotOtaSupported) {
      console.log("OTA: Update Now pressed but glasses not on WiFi - pushing /wifi/scan")
      push("/wifi/scan")
      return
    }
    engine.ota.installSession.prepare(result)
    if (updateFingerprint) {
      beginOtaAutoChain(updateFingerprint, isDowngradeUpdate)
    }
    // One unified progress route: old-build compatibility lives inside the
    // engine install coordinator. The chain remains armed across successful passes.
    navigateToProgress()
  }

  const renderContent = () => {
    // Checking state - no skip button, OTA is mandatory
    if (checkState === "checking") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="world-download" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text tx="ota:checkingForUpdates" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text tx="ota:checkingForUpdatesMessage" className="text-sm text-center" />
            <View className="h-6" />
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          </View>

          {/* No skip button while checking - OTA check is mandatory */}
          <View className="h-12" />
        </>
      )
    }

    // Update available state
    if (checkState === "update_available") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="world-download" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text
              text={translate(isDowngradeUpdate ? "ota:downgradeAvailable" : "ota:updateAvailable", {deviceName})}
              className="font-semibold text-xl text-center"
            />
            <View className="h-4" />
            <Text
              text={
                canInstallUpdate
                  ? translate(isDowngradeUpdate ? "ota:downgradeDescription" : "ota:updateDescription")
                  : translate("ota:updateConnectWifi", {deviceName})
              }
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>

          <View className="gap-3">
            <Button
              preset="primary"
              tx={canInstallUpdate ? "ota:updateNow" : "ota:setupWifi"}
              onPress={handleUpdateNow}
            />
            {!isUpdateRequired && <Button preset="secondary" tx="ota:updateLater" onPress={handleContinue} />}
            {__DEV__ && isUpdateRequired && (
              <Button preset="secondary" text="Skip (dev only)" onPress={handleContinue} />
            )}
          </View>
        </>
      )
    }

    // Local mobile development build: OTA exempt — distinct from "up to date".
    if (checkState === "dev_build") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="settings" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text tx="ota:devBuild" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text tx="ota:devBuildNoOta" className="text-sm text-center" style={{color: theme.colors.textDim}} />
          </View>

          <View className="justify-center items-center mb-6">
            <Button preset="primary" tx="common:continue" flexContainer onPress={handleContinue} />
          </View>
        </>
      )
    }

    // No update state
    if (checkState === "no_update") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="check" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text tx="ota:upToDate" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text tx="ota:noUpdatesAvailable" className="text-sm text-center" style={{color: theme.colors.textDim}} />
          </View>

          <View className="justify-center items-center mb-6">
            <Button preset="primary" tx="common:continue" flexContainer onPress={handleContinue} />
          </View>
        </>
      )
    }

    // Dead pin: retrying cannot help — the update info for this app build does not
    // exist; the remedy is a newer app. Let the user continue rather than trapping
    // them on a retry loop.
    if (checkState === "error" && errorKind === "pin_unavailable") {
      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="alert-triangle" size={64} color={theme.colors.error} />
            <View className="h-6" />
            <Text tx="ota:updateInfoUnavailable" className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text
              tx="ota:updateInfoUnavailableMessage"
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>

          <View className="justify-center items-center mb-6">
            <Button preset="primary" tx="common:continue" flexContainer onPress={handleContinue} />
          </View>
        </>
      )
    }

    // Network-ish error state - retry only, no skip (except dev mode)
    return (
      <>
        <View className="flex-1 items-center justify-center px-6">
          <Icon name="alert-triangle" size={64} color={theme.colors.error} />
          <View className="h-6" />
          <Text tx="ota:checkFailed" className="font-semibold text-xl text-center" />
          <View className="h-2" />
          <Text tx="ota:checkFailedMessage" className="text-sm text-center" style={{color: theme.colors.textDim}} />
        </View>

        <View className="gap-3">
          <Button preset="primary" text="Retry" flexContainer onPress={handleRetry} />
          {__DEV__ && <Button preset="secondary" text="Skip (dev only)" onPress={handleContinue} />}
        </View>
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
