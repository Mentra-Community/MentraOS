import {useFocusEffect} from "expo-router"
import {useEffect, useState, useCallback, useRef} from "react"
import {View, ActivityIndicator} from "react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk"

import {MINIMUM_OTA_STATUS_BUILD} from "@/app/ota/otaProgressTimeouts"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {checkForOtaUpdate, OTA_VERSION_URL_PROD} from "@/effects/OtaUpdateChecker"
import {translate} from "@/i18n/translate"
import {isGlassesConnected, selectGlassesConnected, useGlassesStore, waitForGlassesState} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {BgTimer} from "@mentra/island"

type CheckState = "checking" | "update_available" | "no_update" | "error"

export default function OtaCheckForUpdatesScreen() {
  const {theme} = useAppTheme()
  const {replace, clearHistoryAndGoHome, push} = useNavigationStore.getState()
  const currentBuildNumber = useGlassesStore((state) => state.buildNumber)
  const mtkFirmwareVersion = useGlassesStore((state) => state.mtkFirmwareVersion)
  const besFirmwareVersion = useGlassesStore((state) => state.besFirmwareVersion)
  const glassesWifiConnected = useGlassesStore((state) => state.wifi.state === "connected")
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const deviceName = defaultWearable || "Glasses"
  const glassesConnected = useGlassesStore(selectGlassesConnected)
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)

  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [isUpdateRequired, setIsUpdateRequired] = useState(true) // Default to required if not specified
  const [checkKey, setCheckKey] = useState(0)
  const versionInfoTimeoutRef = useRef<number | null>(null)
  const waitStartTimeRef = useRef<number | null>(null)
  const hasInitiatedCheckRef = useRef(false) // Track if we've initiated check for this checkKey
  const checkCompletedRef = useRef(false) // Guards against stale timeout callbacks firing after check progresses
  /** Incremented each effect run so stale async performCheck exits before mutating state. */
  const performCheckGenerationRef = useRef(0)

  focusEffectPreventBack()

  // Re-run OTA check when screen gains focus (for iterative updates: APK → MTK → BES)
  useFocusEffect(
    useCallback(() => {
      console.log("OTA: Screen focused - triggering re-check")
      setCheckState("checking")
      // Reset timeout tracking for fresh check
      if (versionInfoTimeoutRef.current) {
        BgTimer.clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
      waitStartTimeRef.current = null
      hasInitiatedCheckRef.current = false // Reset for fresh check
      checkCompletedRef.current = false
      setCheckKey((k) => k + 1)
    }, []),
  )

  // Perform OTA check when checkKey changes (on mount and on focus)
  // Also re-run when version info arrives (currentBuildNumber)
  useEffect(() => {
    const MIN_DISPLAY_TIME_MS = 1100
    const MAX_WAIT_FOR_VERSION_INFO_MS = 10000 // Wait up to 10 seconds for version_info
    const myGen = ++performCheckGenerationRef.current
    let cancelled = false

    const performCheck = async () => {
      // Bail out if the check already completed for this checkKey — prevents re-entry
      // when unrelated store fields (e.g. otaUpdateAvailable written by this very check)
      // cause React to re-fire the effect before the dependency array was narrowed.
      if (checkCompletedRef.current) {
        return
      }

      // Only apply early-exit conditions on the FIRST check attempt for this checkKey
      if (!hasInitiatedCheckRef.current) {
        if (!glassesConnected) {
          console.log("OTA: Glasses not connected - proceeding to next step")
          if (versionInfoTimeoutRef.current) {
            BgTimer.clearTimeout(versionInfoTimeoutRef.current)
            versionInfoTimeoutRef.current = null
          }
          hasInitiatedCheckRef.current = true
          handleContinue()
          return
        }
      }

      // Wait for version_info to arrive (contains buildNumber needed to determine OTA URL)
      if (!currentBuildNumber) {
        console.log("OTA: Waiting for version_info from glasses (build:", currentBuildNumber, ")")

        // Start timeout if not already started
        if (!waitStartTimeRef.current) {
          waitStartTimeRef.current = Date.now()
          hasInitiatedCheckRef.current = true // Mark as initiated when starting wait
          console.log("OTA: Starting version_info wait timeout (" + MAX_WAIT_FOR_VERSION_INFO_MS + "ms)")

          // Request version info since we don't have it yet
          console.log("OTA: Requesting version_info from glasses")
          BluetoothSdk.requestVersionInfo()

          versionInfoTimeoutRef.current = BgTimer.setTimeout(() => {
            if (checkCompletedRef.current) {
              console.log("OTA: Timeout fired but check already progressed - ignoring stale timeout")
              return
            }
            console.log("OTA: Timeout waiting for version_info - proceeding to next step")
            waitStartTimeRef.current = null
            versionInfoTimeoutRef.current = null
            handleContinue()
          }, MAX_WAIT_FOR_VERSION_INFO_MS)
        }

        // Don't proceed yet - the effect will re-run when these values change
        return
      }

      // Match OtaUpdateChecker home path: BES often arrives late in version_info_3 (chip init after reflash).
      void BluetoothSdk.requestVersionInfo()

      let latestBesFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
      if (!latestBesFirmwareVersion) {
        console.log("OTA: BES version still unknown - waiting up to 5s for it to arrive...")
        await waitForGlassesState("besFirmwareVersion", (v) => !!v, 5000)
        latestBesFirmwareVersion = useGlassesStore.getState().besFirmwareVersion
        if (latestBesFirmwareVersion) {
          console.log(`OTA: BES version arrived: ${latestBesFirmwareVersion}`)
        } else {
          console.log("OTA: BES version still unknown after extended wait - will assume BES update if published")
        }
      }

      if (cancelled || myGen !== performCheckGenerationRef.current) {
        return
      }
      if (!isGlassesConnected(useGlassesStore.getState().connection)) {
        console.log("OTA: Glasses disconnected while waiting for firmware info")
        return
      }

      let latestMtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
      if (!latestMtkFirmwareVersion) {
        await waitForGlassesState("mtkFirmwareVersion", (v) => !!v, 2000)
        latestMtkFirmwareVersion = useGlassesStore.getState().mtkFirmwareVersion
      }

      if (cancelled || myGen !== performCheckGenerationRef.current) {
        return
      }
      if (!isGlassesConnected(useGlassesStore.getState().connection)) {
        return
      }

      // Clear timeout since we got the data
      if (versionInfoTimeoutRef.current) {
        console.log("OTA: Got version_info - clearing wait timeout")
        BgTimer.clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
      waitStartTimeRef.current = null
      checkCompletedRef.current = true
      hasInitiatedCheckRef.current = true

      const startTime = Date.now()

      try {
        // Refresh version_info (build / fw) in case the store still held values from a prior session
        // before the native clear-on-connect + glasses_ready re-query completed.
        console.log("OTA: Requesting fresh version_info from glasses before HTTP compare")
        void BluetoothSdk.requestVersionInfo()

        const result = await checkForOtaUpdate(
          OTA_VERSION_URL_PROD,
          currentBuildNumber,
          latestMtkFirmwareVersion,
          latestBesFirmwareVersion,
        )
        console.log("📱 OTA check completed - result:", JSON.stringify(result))

        // Calculate remaining time to meet minimum display duration
        const elapsed = Date.now() - startTime
        const remainingDelay = Math.max(0, MIN_DISPLAY_TIME_MS - elapsed)

        // Wait for minimum display time before showing result
        await new Promise((resolve) => setTimeout(resolve, remainingDelay))

        if (!result.hasCheckCompleted) {
          console.log("📱 OTA check did not complete - setting error state")
          setCheckState("error")
          return
        }

        if (result.updateAvailable && result.latestVersionInfo) {
          // Filter out MTK if it was already updated this session
          const mtkUpdatedThisSession = useGlassesStore.getState().mtkUpdatedThisSession
          let filteredUpdates = result.updates || []
          if (mtkUpdatedThisSession && filteredUpdates.includes("mtk")) {
            console.log("📱 Filtering out MTK - already updated this session (pending reboot)")
            filteredUpdates = filteredUpdates.filter((u) => u !== "mtk")
          }

          if (filteredUpdates.length > 0) {
            console.log("📱 Updates available - setting update_available state")
            // If isRequired is not specified in version.json, default to true (forced update)
            setIsUpdateRequired(result.latestVersionInfo?.isRequired !== false)
            // Store the update info in global state so progress screen can access the sequence.
            // cacheReady: false ensures the home-screen "cache-ready" popup in OtaUpdateChecker
            // does not fire on this in-flow write — only true cache-ready signals from the glasses
            // (see MantleManager ota_update_available listener) should trip that popup.
            useGlassesStore.getState().setOtaUpdateAvailable({
              available: true,
              versionCode: result.latestVersionInfo?.versionCode || 0,
              versionName: result.latestVersionInfo?.versionName || "",
              updates: filteredUpdates,
              totalSize: 0,
              cacheReady: false,
            })
            setCheckState("update_available")
          } else {
            console.log("📱 No updates available after filtering - setting no_update state")
            useGlassesStore.getState().setOtaUpdateAvailable(null)
            setCheckState("no_update")
          }
        } else {
          console.log("📱 No updates available - setting no_update state")
          useGlassesStore.getState().setOtaUpdateAvailable(null)
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
      if (versionInfoTimeoutRef.current) {
        BgTimer.clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
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
    if (versionInfoTimeoutRef.current) {
      BgTimer.clearTimeout(versionInfoTimeoutRef.current)
      versionInfoTimeoutRef.current = null
    }
    waitStartTimeRef.current = null
    hasInitiatedCheckRef.current = false
    checkCompletedRef.current = false
    setCheckKey((k) => k + 1)
  }

  const handleUpdateNow = () => {
    if (useGlassesStore.getState().wifi.state !== "connected") {
      console.log("OTA: Update Now pressed but glasses not on WiFi - pushing /wifi/scan")
      push("/wifi/scan")
      return
    }
    const store = useGlassesStore.getState()
    const otaProgressBefore = store.otaProgress
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
    store.setOtaProgress(null)
    store.setOtaStatus(null)
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
