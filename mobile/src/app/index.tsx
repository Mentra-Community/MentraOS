import {useState, useEffect} from "react"
import {View, ActivityIndicator, Platform, Linking} from "react-native"
import {TextStyle, ViewStyle} from "react-native"
import semver from "semver"

import {Button, Icon, Screen} from "@/components/ignite"
import {Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {useDeeplink} from "@/contexts/DeeplinkContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import mantle from "@/services/MantleManager"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

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
const NAVIGATION_DELAY = 100
const DEEPLINK_DELAY = 1000

export default function InitScreen() {
  // Hooks
  const {theme, themed} = useAppTheme()
  const {user, session, loading: authLoading} = useAuth()
  const {replace, getPendingRoute, setPendingRoute} = useNavigationHistory()
  const {processUrl} = useDeeplink()

  // State
  const [state, setState] = useState<ScreenState>("loading")
  const [localVersion, setLocalVersion] = useState<string | null>(null)
  const [cloudVersion, setCloudVersion] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isUsingCustomUrl, setIsUsingCustomUrl] = useState(false)
  const [canSkipUpdate, setCanSkipUpdate] = useState(false)
  const [loadingStatus, setLoadingStatus] = useState<string>(translate("versionCheck:checkingForUpdates"))
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

  const navigateToDestination = async () => {
    if (!user?.email) {
      replace("/auth/login")
      return
    }

    // Check onboarding status
    if (!onboardingCompleted && !defaultWearable) {
      replace("/onboarding/welcome")
      return
    }

    const pendingRoute = getPendingRoute()
    if (pendingRoute) {
      setPendingRoute(null)
      setTimeout(() => processUrl(pendingRoute), DEEPLINK_DELAY)
      return
    }

    setTimeout(() => {
      // clearHistoryAndGoHome()
      replace("/(tabs)/home")
    }, NAVIGATION_DELAY)
  }

  const checkLoggedIn = async (): Promise<void> => {
    if (!user) {
      replace("/auth/login")
      return
    }
    handleTokenExchange()
  }

  const handleTokenExchange = async (): Promise<void> => {
    setState("loading")
    setLoadingStatus(translate("versionCheck:connectingToServer"))

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
      setLoadingStatus(translate("versionCheck:checkingForUpdates"))
    } else {
      setIsRetrying(true)
    }

    const localVer = getLocalVersion()
    setLocalVersion(localVer)
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
    setCloudVersion(recommended)
    console.log(`INIT: Version check: local=${localVer}, required=${required}, recommended=${recommended}`)
    if (semver.lt(localVer, recommended)) {
      setState("outdated")
      setCanSkipUpdate(!semver.lt(localVer, required))
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
          iconColor: theme.colors.error,
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
          iconColor: theme.colors.tint,
          title: "Update Required",
          description: "MentraOS is outdated. Please update to continue using the application.",
        }

      default:
        return {
          icon: "check-circle",
          iconColor: theme.colors.palette.primary500,
          title: "Up to Date",
          description: "MentraOS is up to date. Returning to home...",
        }
    }
  }

  // Effects
  useEffect(() => {
    console.log("INIT: Auth loading:", authLoading)
    const init = async () => {
      await checkCustomUrl()
      await checkCloudVersion()
    }
    if (!authLoading) {
      console.log("INIT: Auth loaded, starting init")
      // auth is loaded, so we can start:
      init()
    }
  }, [authLoading])

  // Render
  if (state === "loading") {
    return (
      <Screen preset="fixed" safeAreaEdges={["bottom"]}>
        <View style={themed($centerContainer)}>
          <ActivityIndicator size="large" color={theme.colors.tint} />
          <Text style={themed($loadingText)}>{loadingStatus}</Text>
        </View>
      </Screen>
    )
  }

  const statusConfig = getStatusConfig()

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <View style={themed($mainContainer)}>
        <View style={themed($infoContainer)}>
          <View style={themed($iconContainer)}>
            <Icon name={statusConfig.icon} size={80} color={statusConfig.iconColor} />
          </View>

          <Text style={themed($title)}>{statusConfig.title}</Text>
          <Text style={themed($description)}>{statusConfig.description}</Text>

          {state === "outdated" && (
            <>
              {localVersion && <Text style={themed($versionText)}>Local: v{localVersion}</Text>}
              {cloudVersion && <Text style={themed($versionText)}>Latest: v{cloudVersion}</Text>}
            </>
          )}

          <View style={themed($buttonContainer)}>
            {state === "connection" ||
              (state === "auth" && (
                <Button
                  flexContainer
                  onPress={() => checkCloudVersion(true)}
                  style={themed($primaryButton)}
                  text={isRetrying ? translate("versionCheck:retrying") : translate("versionCheck:retryConnection")}
                  disabled={isRetrying}
                  LeftAccessory={
                    isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.textAlt} /> : undefined
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
                style={themed($secondaryButton)}
                tx={isRetrying ? "versionCheck:resetting" : "versionCheck:resetUrl"}
                preset="secondary"
                disabled={isRetrying}
                LeftAccessory={
                  isRetrying ? () => <ActivityIndicator size="small" color={theme.colors.text} /> : undefined
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

// Styles
const $centerContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  marginTop: spacing.s4,
  fontSize: 16,
  color: colors.text,
})

const $mainContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
})

const $infoContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingTop: spacing.s8,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s8,
})

const $title: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 28,
  fontWeight: "bold",
  textAlign: "center",
  marginBottom: spacing.s4,
  color: colors.text,
})

const $description: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  textAlign: "center",
  marginBottom: spacing.s8,
  lineHeight: 24,
  paddingHorizontal: spacing.s6,
  color: colors.textDim,
})

const $versionText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  textAlign: "center",
  marginBottom: spacing.s2,
  color: colors.textDim,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  alignItems: "center",
  paddingBottom: spacing.s8,
  gap: spacing.s8,
})

const $primaryButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $secondaryButton: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})
