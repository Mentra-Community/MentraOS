import {useRootNavigationState} from "expo-router"
import {useState, useEffect, useRef} from "react"
import {View, ActivityIndicator, Platform, Linking} from "react-native"
import semver from "semver"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {useAuth} from "@/contexts/AuthContext"
import {useDeeplink} from "@/contexts/DeeplinkContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {BackgroundTimer} from "@/utils/timers"

// Types
type ScreenState = "loading" | "connection" | "auth" | "outdated" | "success"

interface StatusConfig {
  icon: string
  iconColor: string
  title: string
  description: string
}

// Constants
const APP_STORE_URL = "https://apps.apple.com/app/id6747363193"
const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.mentra.mentra"
const NAVIGATION_DELAY = 300
const DEEPLINK_DELAY = 1000

export default function InitScreen() {
  // Hooks
  const {theme} = useAppTheme()
  const {user, session, loading: authLoading} = useAuth()
  const {replace, replaceAll, getPendingRoute, setPendingRoute, clearHistoryAndGoHome, setAnimation} =
    useNavigationHistory()
  const {processUrl} = useDeeplink()
  const rootNavigationState = useRootNavigationState()
  const isNavigationReady = rootNavigationState?.key != null

  // State
  const [state, setState] = useState<ScreenState>("loading")
  const [localVersion, setLocalVersion] = useState<string | null>(null)
  const [cloudVersion, setCloudVersion] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isUsingCustomUrl, setIsUsingCustomUrl] = useState(false)
  const [canSkipUpdate, setCanSkipUpdate] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [isBlockedByVersion, setIsBlockedByVersion] = useState(false)
  // Zustand store hooks
  const [backendUrl, setBackendUrl] = useSetting(SETTINGS.backend_url.key)
  const [onboardingCompleted, _setOnboardingCompleted] = useSetting(SETTINGS.onboarding_completed.key)
  const [defaultWearable, _setDefaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [cachedRequiredVersion, setCachedRequiredVersion] = useSetting(SETTINGS.cached_required_version.key)

  // Helper Functions
  const getLocalVersion = (): string | null => {
    try {
      return process.env.EXPO_PUBLIC_MENTRAOS_VERSION || null
    } catch (error) {
      console.error("Error getting local version:", error)
      return null
    }
  }

  const checkCustomUrl = async (): Promise<boolean> => {
    const defaultUrl = SETTINGS[SETTINGS.backend_url.key].defaultValue()
    // Read directly from the store to avoid stale React closure values
    const currentUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key)
    const isCustom = currentUrl !== defaultUrl
    setIsUsingCustomUrl(isCustom)
    return isCustom
  }

  const setAnimationDelayed = () => {
    BackgroundTimer.setTimeout(() => {
      setAnimation("simple_push")
    }, 800)
  }

  const navigateToDestination = async () => {
    if (!user?.email) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace("/auth/start", {transition: "fade"})
      return
    }

    // Check onboarding status
    if (!onboardingCompleted && !defaultWearable) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace("/onboarding/welcome", {transition: "fade"})
      return
    }

    const pendingRoute = getPendingRoute()
    if (pendingRoute) {
      setPendingRoute(null)
      // Navigate to home first so the deep link screen has a proper back destination
      clearHistoryAndGoHome({transition: "fade"})
      setTimeout(() => processUrl(pendingRoute), DEEPLINK_DELAY)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
    setAnimationDelayed()
    clearHistoryAndGoHome({transition: "fade"})
  }

  const checkLoggedIn = async (): Promise<void> => {
    if (!user) {
      replaceAll("/auth/start")
      return
    }
    handleTokenExchange()
  }

  const handleTokenExchange = async (): Promise<void> => {
    const token = session?.token
    if (!token) {
      setState("auth")
      return
    }

    let res = await restComms.exchangeToken(token)
    if (res.is_error()) {
      console.log("Token exchange failed:", res.error)
      await checkCustomUrl()
      setState("connection")
      return
    }

    const coreToken = res.value
    const uid = user?.email || user?.id || ""

    socketComms.setAuthCreds(coreToken, uid)
    console.log("INIT: Socket comms auth creds set")
    await mantle.init()
    console.log("INIT: Mantle initialized")

    await navigateToDestination()
  }

  const checkCloudVersion = async (isRetry = false): Promise<void> => {
    // Only show loading screen on initial load, not on retry
    if (!isRetry) {
      setState("loading")
    } else {
      setIsRetrying(true)
    }

    const localVer = getLocalVersion()
    console.log("INIT: Local version:", localVer)

    if (!localVer) {
      console.error("Failed to get local version")
      setState("connection")
      setIsRetrying(false)
      return
    }

    const res = await restComms.getMinimumClientVersion()
    if (res.is_error()) {
      console.error("Failed to fetch cloud version:", res.error)

      // Even offline, check cached required version to block outdated apps
      if (cachedRequiredVersion && semver.lt(localVer, cachedRequiredVersion)) {
        console.log(`INIT: Offline but app is below cached required version (${localVer} < ${cachedRequiredVersion})`)
        setLocalVersion(localVer)
        setCloudVersion(cachedRequiredVersion)
        setCanSkipUpdate(false)
        setIsBlockedByVersion(true)
        setState("outdated")
        setIsRetrying(false)
        return
      }

      setState("connection")
      setIsRetrying(false)
      return
    }

    const {required, recommended} = res.value
    console.log(`INIT: Version check: local=${localVer}, required=${required}, recommended=${recommended}`)

    // Cache the required version for offline enforcement
    if (required && required !== cachedRequiredVersion) {
      setCachedRequiredVersion(required)
    }

    if (semver.lt(localVer, recommended)) {
      setLocalVersion(localVer)
      setCloudVersion(recommended)
      setCanSkipUpdate(!semver.lt(localVer, required))
      setIsBlockedByVersion(semver.lt(localVer, required))
      setState("outdated")
      setIsRetrying(false)
      return
    }

    setIsRetrying(false)
    checkLoggedIn()
  }

  const handleUpdate = async (): Promise<void> => {
    setIsUpdating(true)
    try {
      const url = Platform.OS === "ios" ? APP_STORE_URL : PLAY_STORE_URL
      await Linking.openURL(url)
    } catch (error) {
      console.error("Error opening store:", error)
    } finally {
      setIsUpdating(false)
    }
  }

  const handleResetUrl = async (): Promise<void> => {
    try {
      const defaultUrl = SETTINGS[SETTINGS.backend_url.key].defaultValue()
      await setBackendUrl(defaultUrl)
      setIsUsingCustomUrl(false)
      await checkCloudVersion(true) // Pass true for retry to avoid flash
    } catch (error) {
      console.error("Failed to reset URL:", error)
    }
  }

  const getStatusConfig = (): StatusConfig => {
    switch (state) {
      case "auth":
        return {
          icon: "account-alert",
          iconColor: theme.colors.destructive,
          title: translate("versionCheck:authErrorTitle"),
          description: translate("versionCheck:authErrorDescription"),
        }

      case "connection":
        return {
          icon: "wifi-off",
          iconColor: theme.colors.destructive,
          title: translate("versionCheck:connectionErrorTitle"),
          description: isUsingCustomUrl
            ? translate("versionCheck:connectionErrorCustomUrl")
            : translate("versionCheck:connectionErrorDescription"),
        }

      case "outdated":
        return {
          icon: "update",
          iconColor: theme.colors.destructive,
          title: translate(canSkipUpdate ? "versionCheck:updateAvailableTitle" : "versionCheck:updateRequiredTitle"),
          description: translate(
            canSkipUpdate ? "versionCheck:updateAvailableDescription" : "versionCheck:updateRequiredDescription",
          ),
        }

      default:
        return {
          icon: "check-circle",
          iconColor: theme.colors.primary,
          title: translate("versionCheck:upToDateTitle"),
          description: translate("versionCheck:upToDateDescription"),
        }
    }
  }

  // Effects
  useEffect(() => {
    console.log("INIT: Auth loading:", authLoading, "Navigation ready:", isNavigationReady)
    const init = async () => {
      await checkCustomUrl()
      await checkCloudVersion()
    }
    // Wait for both auth to load AND navigation to be ready before initializing
    // This prevents "navigate before mounting Root Layout" crashes (MENTRA-OS-152)
    if (!authLoading && isNavigationReady) {
      console.log("INIT: Auth loaded and navigation ready, starting init")
      init()
    }
  }, [authLoading, isNavigationReady])

  // Clear cached required version when backend URL changes so a stricter
  // server's requirement doesn't block access to a different backend.
  // Skip the initial mount so the cached value is preserved for offline enforcement.
  const backendUrlRef = useRef(backendUrl)
  useEffect(() => {
    if (backendUrlRef.current !== backendUrl) {
      backendUrlRef.current = backendUrl
      if (cachedRequiredVersion) {
        setCachedRequiredVersion("")
      }
    }
  }, [backendUrl])

  useEffect(() => {
    setAnimation("fade")
  }, [])

  // Render
  if (state === "loading") {
    return (
      <Screen preset="fixed" extraAndroidInsets>
        <SplashVideo colorOverride={superMode ? theme.colors.chart_4 : undefined} />
      </Screen>
    )
  }

  const statusConfig = getStatusConfig()

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header RightActionComponent={<MentraLogoStandalone />} />

      {/* Content */}
      <View className="flex-1 items-center justify-center px-6">
        {state === "outdated" ? (
          <MentraLogoStandalone width={100} height={48} />
        ) : (
          <Icon name={statusConfig.icon as any} size={64} color={statusConfig.iconColor} />
        )}
        <View className="h-6" />
        <Text text={statusConfig.title} className="font-semibold text-xl text-center" />
        <View className="h-2" />
        <Text text={statusConfig.description} className="text-sm text-center" style={{color: theme.colors.textDim}} />

        {/* Version info — only visible in super mode */}
        {state === "outdated" && superMode && localVersion && cloudVersion && (
          <>
            <View className="h-4" />
            <Text
              text={`v${localVersion} → v${cloudVersion}`}
              className="text-xs text-center"
              style={{color: theme.colors.textDim}}
            />
          </>
        )}
      </View>

      {/* Buttons */}
      <View className="gap-3">
        {(state === "connection" || state === "auth") && (
          <Button
            flexContainer
            onPress={() => checkCloudVersion(true)}
            text={isRetrying ? translate("versionCheck:retrying") : translate("versionCheck:retryConnection")}
            disabled={isRetrying}
            LeftAccessory={
              isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.foreground} /> : undefined
            }
          />
        )}

        {state === "outdated" && (
          <Button
            flexContainer
            preset="primary"
            onPress={handleUpdate}
            disabled={isUpdating}
            tx={canSkipUpdate ? "versionCheck:update" : "versionCheck:updateRequiredButton"}
          />
        )}

        {(state === "connection" || state === "auth") && isUsingCustomUrl && (
          <Button
            flexContainer
            onPress={handleResetUrl}
            tx={isRetrying ? "versionCheck:resetting" : "versionCheck:resetUrl"}
            preset="secondary"
            disabled={isRetrying}
            LeftAccessory={
              isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.foreground} /> : undefined
            }
          />
        )}

        {(((state === "connection" || state === "auth") && !isBlockedByVersion) ||
          (state === "outdated" && canSkipUpdate)) && (
          <Button flexContainer preset="secondary" onPress={navigateToDestination} tx="versionCheck:continueAnyway" />
        )}
      </View>
    </Screen>
  )
}
