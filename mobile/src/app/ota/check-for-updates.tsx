import {useFocusEffect} from "expo-router"
import {useEffect, useState, useCallback, useRef} from "react"
import {View, ActivityIndicator} from "react-native"

import {MINIMUM_OTA_STATUS_BUILD} from "@/app/ota/otaProgressTimeouts"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {toolkit} from "@mentra/island"

type CheckState = "checking" | "update_available" | "no_update" | "error"

export default function OtaCheckForUpdatesScreen() {
  const {theme} = useAppTheme()
  const {replace, clearHistoryAndGoHome, push} = useNavigationStore.getState()
  const otaSnapshot = useToolkitSnapshot(toolkit.ota.snapshot, toolkit.ota.onSnapshot)
  const currentBuildNumber = otaSnapshot.buildNumber
  const mtkFirmwareVersion = otaSnapshot.mtkFirmwareVersion
  const besFirmwareVersion = otaSnapshot.besFirmwareVersion
  const glassesWifiConnected = otaSnapshot.wifiConnected
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const deviceName = defaultWearable || "Glasses"
  const glassesConnected = otaSnapshot.connected
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)

  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [isUpdateRequired, setIsUpdateRequired] = useState(true) // Default to required if not specified
  const [checkKey, setCheckKey] = useState(0)
  /** Incremented each effect run so stale async performCheck exits before mutating state. */
  const performCheckGenerationRef = useRef(0)

  focusEffectPreventBack()

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
    const myGen = ++performCheckGenerationRef.current
    let cancelled = false

    const performCheck = async () => {
      if (!glassesConnected) {
        console.log("OTA: Glasses not connected - proceeding to next step")
        handleContinue()
        return
      }

      const startTime = Date.now()

      try {
        console.log("OTA: Checking current glasses via toolkit OTA")
        const result = await toolkit.ota.checkForUpdates({
          waitForBuildNumberMs: MAX_WAIT_FOR_VERSION_INFO_MS,
          waitForBesVersionMs: 5000,
          waitForMtkVersionMs: 2000,
          refreshVersionInfo: true,
          fixClockBeforeCheck: false,
        })
        console.log("📱 OTA check completed - result:", JSON.stringify(result))

        // Calculate remaining time to meet minimum display duration
        const elapsed = Date.now() - startTime
        const remainingDelay = Math.max(0, MIN_DISPLAY_TIME_MS - elapsed)

        // Wait for minimum display time before showing result
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))

        if (cancelled || myGen !== performCheckGenerationRef.current) {
          return
        }

        if (result.skippedReason === "disconnected" || result.skippedReason === "missing_build") {
          console.log(`OTA: Check skipped (${result.skippedReason}) - proceeding to next step`)
          handleContinue()
          return
        }

        if (!result.hasCheckCompleted) {
          console.log("📱 OTA check did not complete - setting error state")
          setCheckState("error")
          return
        }

        if (result.updateAvailable && result.updateInfo) {
          console.log("📱 Updates available - setting update_available state")
          setIsUpdateRequired(result.isRequired)
          setCheckState("update_available")
        } else {
          console.log("📱 No updates available - setting no_update state")
          toolkit.ota.clearUpdateAvailable()
          setCheckState("no_update")
        }
      } catch (error) {
        console.error("OTA check failed:", error)
        // Still respect minimum display time on error
        const elapsed = Date.now() - startTime
        const remainingDelay = Math.max(0, MIN_DISPLAY_TIME_MS - elapsed)
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))
        setCheckState("error")
      }
    }

    performCheck()

    // Cleanup timeouts on unmount or when dependencies change
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, currentBuildNumber, mtkFirmwareVersion, besFirmwareVersion, glassesConnected])

  // Navigate to next step based on onboarding status
  const handleContinue = () => {
    console.log("OTA: handleContinue() - onboardingLiveCompleted:", onboardingLiveCompleted)
    if (!onboardingLiveCompleted) {
      // Fresh pairing - go to onboarding (replace so back from onboarding goes home, not back to OTA)
      console.log("OTA: Fresh pairing - navigating to onboarding")
      replace("/onboarding/live")
    } else {
      // Not fresh pairing - go home
      console.log("OTA: Onboarding already done - navigating home")
      clearHistoryAndGoHome()
    }
  }

  // Retry OTA check
  const handleRetry = () => {
    console.log("OTA: handleRetry()")
    setCheckState("checking")
    setCheckKey((k) => k + 1)
  }

  const handleUpdateNow = () => {
    if (!toolkit.ota.snapshot().wifiConnected) {
      console.log("OTA: Update Now pressed but glasses not on WiFi - pushing /wifi/scan")
      push("/wifi/scan")
      return
    }
    const otaProgressBefore = toolkit.ota.snapshot().legacyProgress
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
    toolkit.ota.clearProgress()
    const buildNum = parseInt(currentBuildNumber || "0", 10)
    const route = buildNum > 0 && buildNum < MINIMUM_OTA_STATUS_BUILD ? "/ota/progress-legacy" : "/ota/progress"
    replace(route)
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
            <Text text={translate("ota:updateAvailable", {deviceName})} className="font-semibold text-xl text-center" />
            <View className="h-4" />
            <Text
              text={
                glassesWifiConnected
                  ? translate("ota:updateDescription")
                  : translate("ota:updateConnectWifi", {deviceName})
              }
              className="text-sm text-center"
              style={{color: theme.colors.textDim}}
            />
          </View>

          <View className="gap-3">
            <Button
              preset="primary"
              tx={glassesWifiConnected ? "ota:updateNow" : "ota:setupWifi"}
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

    // Error state - retry only, no skip (except dev mode)
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
