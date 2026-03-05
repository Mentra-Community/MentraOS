import {useRootNavigationState} from "expo-router"
import {useState, useEffect} from "react"
import {View, ActivityIndicator, Platform, Linking} from "react-native"
import semver from "semver"

import {Button, Icon, Screen, Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {useDeeplink} from "@/contexts/DeeplinkContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {SETTINGS, useSetting} from "@/stores/settings"
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
const APP_STORE_URL = "https://mentra.glass/os"
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
  // Zustand store hooks
  const [backendUrl, setBackendUrl] = useSetting(SETTINGS.backend_url.key)
  const [onboardingCompleted, _setOnboardingCompleted] = useSetting(SETTINGS.onboarding_completed.key)
  const [defaultWearable, _setDefaultWearable] = useSetting(SETTINGS.default_wearable.key)

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
    const isCustom = backendUrl !== defaultUrl
    setIsUsingCustomUrl(isCustom)
    return isCustom
  }

  const setAnimationDelayed = () => {
    BackgroundTimer.setTimeout(() => {
      setAnimation("simple_push")
    }, 500)
  }

  const navigateToDestination = async () => {
    if (!user?.email) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace("/auth/start")
      setAnimationDelayed()
      return
    }

    // Check onboarding status
    if (!onboardingCompleted && !defaultWearable) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace("/onboarding/welcome")
      setAnimationDelayed()
      return
    }

    const pendingRoute = getPendingRoute()
    if (pendingRoute) {
      setPendingRoute(null)
      setTimeout(() => processUrl(pendingRoute), DEEPLINK_DELAY)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
    setAnimationDelayed()
    clearHistoryAndGoHome()
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
      setState("connection")
      setIsRetrying(false)
      return
    }

    const {required, recommended} = res.value
    console.log(`INIT: Version check: local=${localVer}, required=${required}, recommended=${recommended}`)
    if (semver.lt(localVer, recommended)) {
      setLocalVersion(localVer)
      setCloudVersion(recommended)
      setCanSkipUpdate(!semver.lt(localVer, required))
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
          title: "Authentication Error",
          description: "Unable to authenticate. Please sign in again.",
        }

      case "connection":
        return {
          icon: "wifi-off",
          iconColor: theme.colors.destructive,
          title: "Connection Error",
          description: isUsingCustomUrl
            ? "Could not connect to the custom server. Please try using the default server or check your connection."
            : "Could not connect to the server. Please check your connection and try again.",
        }

      case "outdated":
        return {
          icon: "update",
          iconColor: theme.colors.destructive,
          title: "Update Required",
          description: "MentraOS is outdated. Please update to continue using the application.",
        }

      default:
        return {
          icon: "check-circle",
          iconColor: theme.colors.primary,
          title: "Up to Date",
          description: "MentraOS is up to date. Returning to home...",
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

  useEffect(() => {
    setAnimation("fade")
  }, [])

  // Render
  if (state === "loading") {
    return (
      <Screen preset="fixed">
        <SplashVideo />
      </Screen>
    )
  }

  const statusConfig = getStatusConfig()

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <View className="flex-1 p-6">
        <View className="flex-1 items-center justify-center pt-8">
          <View className="mb-8">
            <Icon name={statusConfig.icon} size={80} color={statusConfig.iconColor} />
          </View>

          <Text className="text-2xl font-bold text-center mb-4">{statusConfig.title}</Text>
          <Text className="text-sm text-center mb-4 line-height-6 px-6 text-muted-foreground">
            {statusConfig.description}
          </Text>

          {state === "outdated" && (
            <>
              {localVersion && (
                <Text className="text-sm text-center mb-2 text-muted-foreground">Local: v{localVersion}</Text>
              )}
              {cloudVersion && (
                <Text className="text-sm text-center mb-2 text-muted-foreground">Latest: v{cloudVersion}</Text>
              )}
            </>
          )}

          <View className="w-full items-center pb-8 gap-8">
            {state === "connection" ||
              (state === "auth" && (
                <Button
                  flexContainer
                  onPress={() => checkCloudVersion(true)}
                  className="w-full"
                  text={isRetrying ? translate("versionCheck:retrying") : translate("versionCheck:retryConnection")}
                  disabled={isRetrying}
                  LeftAccessory={
                    isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.foreground} /> : undefined
                  }
                />
              ))}

            {state === "outdated" && (
              <Button
                flexContainer
                preset="primary"
                onPress={handleUpdate}
                disabled={isUpdating}
                tx="versionCheck:update"
              />
            )}

            {(state === "connection" || state === "auth") && isUsingCustomUrl && (
              <Button
                flexContainer
                onPress={handleResetUrl}
                className="w-full"
                tx={isRetrying ? "versionCheck:resetting" : "versionCheck:resetUrl"}
                preset="secondary"
                disabled={isRetrying}
                LeftAccessory={
                  isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.foreground} /> : undefined
                }
              />
            )}

            {(state === "connection" || state == "auth" || (state === "outdated" && canSkipUpdate)) && (
              <Button
                flex
                flexContainer
                preset="warning"
                RightAccessory={() => <Icon name="arrow-right" size={24} color={theme.colors.text} />}
                onPress={navigateToDestination}
                tx="versionCheck:continueAnyway"
              />
            )}
          </View>
        </View>
      </View>
    </Screen>
  )
}
