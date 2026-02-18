import {useFocusEffect} from "expo-router"
import {useEffect, useState, useCallback, useRef} from "react"
import {View, ActivityIndicator} from "react-native"
import CoreModule from "core"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen, Header, Button, Text, Icon} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {checkForOtaUpdate, OTA_VERSION_URL_PROD} from "@/effects/OtaUpdateChecker"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"

type CheckState = "checking" | "update_available" | "no_update" | "error"

export default function OtaCheckForUpdatesScreen() {
  const {theme} = useAppTheme()
  const {replace, clearHistoryAndGoHome} = useNavigationHistory()
  const currentBuildNumber = useGlassesStore((state) => state.buildNumber)
  const mtkFwVersion = useGlassesStore((state) => state.mtkFwVersion)
  const besFwVersion = useGlassesStore((state) => state.besFwVersion)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const deviceName = defaultWearable || "Glasses"
  const glassesConnected = useGlassesStore((state) => state.connected)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)

  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [checkState, setCheckState] = useState<CheckState>("checking")
  const [availableUpdates, setAvailableUpdates] = useState<string[]>([])
  const [isUpdateRequired, setIsUpdateRequired] = useState(true) // Default to required if not specified
  const [checkKey, setCheckKey] = useState(0)
  const versionInfoTimeoutRef = useRef<number | null>(null)
  const waitStartTimeRef = useRef<number | null>(null)
  const hasInitiatedCheckRef = useRef(false) // Track if we've initiated check for this checkKey

  focusEffectPreventBack()

  // Re-run OTA check when screen gains focus (for iterative updates: APK → MTK → BES)
  useFocusEffect(
    useCallback(() => {
      console.log("OTA: Screen focused - triggering re-check")
      setCheckState("checking")
      setAvailableUpdates([])
      // Reset timeout tracking for fresh check
      if (versionInfoTimeoutRef.current) {
        clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
      waitStartTimeRef.current = null
      hasInitiatedCheckRef.current = false // Reset for fresh check
      setCheckKey((k) => k + 1)
    }, []),
  )

  // Perform OTA check when checkKey changes (on mount and on focus)
  // Also re-run when version info arrives (currentBuildNumber)
  useEffect(() => {
    const MIN_DISPLAY_TIME_MS = 1100
    const MAX_WAIT_FOR_VERSION_INFO_MS = 10000 // Wait up to 10 seconds for version_info

    const performCheck = async () => {
      // Only apply early-exit conditions on the FIRST check attempt for this checkKey
      // This prevents auto-navigation when WiFi/connection state changes mid-operation
      if (!hasInitiatedCheckRef.current) {
        // If glasses disconnected or WiFi not connected on initial check, skip immediately
        if (!glassesConnected) {
          console.log("OTA: Glasses not connected - proceeding to next step")
          if (versionInfoTimeoutRef.current) {
            clearTimeout(versionInfoTimeoutRef.current)
            versionInfoTimeoutRef.current = null
          }
          hasInitiatedCheckRef.current = true
          handleContinue()
          return
        }
        if (!wifiConnected) {
          console.log("OTA: WiFi not connected - proceeding to next step")
          if (versionInfoTimeoutRef.current) {
            clearTimeout(versionInfoTimeoutRef.current)
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
          CoreModule.requestVersionInfo()

          versionInfoTimeoutRef.current = setTimeout(() => {
            console.log("OTA: Timeout waiting for version_info - proceeding to next step")
            waitStartTimeRef.current = null
            versionInfoTimeoutRef.current = null
            handleContinue()
          }, MAX_WAIT_FOR_VERSION_INFO_MS)
        }

        // Don't proceed yet - the effect will re-run when these values change
        return
      }

      // Clear timeout since we got the data
      if (versionInfoTimeoutRef.current) {
        console.log("OTA: Got version_info - clearing wait timeout")
        clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
      waitStartTimeRef.current = null
      hasInitiatedCheckRef.current = true // Mark as initiated before starting check

      const startTime = Date.now()

      try {
        const result = await checkForOtaUpdate(OTA_VERSION_URL_PROD, currentBuildNumber, mtkFwVersion, besFwVersion)
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
            setAvailableUpdates(filteredUpdates)
            // If isRequired is not specified in version.json, default to true (forced update)
            setIsUpdateRequired(result.latestVersionInfo?.isRequired !== false)
            // Store the update info in global state so progress screen can access the sequence
            useGlassesStore.getState().setOtaUpdateAvailable({
              available: true,
              versionCode: result.latestVersionInfo?.versionCode || 0,
              versionName: result.latestVersionInfo?.versionName || "",
              updates: filteredUpdates,
              totalSize: 0,
            })
            setCheckState("update_available")
          } else {
            console.log("📱 No updates available after filtering - setting no_update state")
            setCheckState("no_update")
          }
        } else {
          console.log("📱 No updates available - setting no_update state")
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

    // Cleanup timeout on unmount or when dependencies change
    return () => {
      if (versionInfoTimeoutRef.current) {
        clearTimeout(versionInfoTimeoutRef.current)
        versionInfoTimeoutRef.current = null
      }
    }
  }, [checkKey, currentBuildNumber, glassesConnected, wifiConnected])

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
    setAvailableUpdates([])
    setCheckKey((k) => k + 1)
  }

  const handleUpdateNow = () => {
    console.log("OTA: handleUpdateNow()")
    // Replace with progress screen to avoid stacking OTA screens
    replace("/ota/progress")
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
      const updateCount = availableUpdates.length
      // Super mode shows technical details (APK, MTK, BES), normal mode shows simple count
      const updateText = superMode
        ? `Updates available: ${availableUpdates.map((u) => u.toUpperCase()).join(", ")}`
        : updateCount === 1
          ? "1 update available"
          : `${updateCount} updates available`

      return (
        <>
          <View className="flex-1 items-center justify-center px-6">
            <Icon name="world-download" size={64} color={theme.colors.primary} />
            <View className="h-6" />
            <Text text={translate("ota:updateAvailable", {deviceName})} className="font-semibold text-xl text-center" />
            <View className="h-2" />
            <Text text={updateText} className="text-base text-center" style={{color: theme.colors.textDim}} />
            <View className="h-4" />
            <Text tx="ota:updateDescription" className="text-sm text-center" style={{color: theme.colors.textDim}} />
          </View>

          <View className="gap-3 mb-6">
            <Button preset="primary" tx="ota:updateNow" onPress={handleUpdateNow} />
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
          <Icon name="warning" size={64} color={theme.colors.error} />
          <View className="h-6" />
          <Text tx="ota:checkFailed" className="font-semibold text-xl text-center" />
          <View className="h-2" />
          <Text tx="ota:checkFailedMessage" className="text-sm text-center" style={{color: theme.colors.textDim}} />
        </View>

        <View className="gap-3 pb-2 mb-6">
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
