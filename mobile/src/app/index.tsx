import {useRootNavigationState} from "expo-router"
import {useState, useEffect, useRef, useCallback} from "react"
import {View, ActivityIndicator, Platform, Linking} from "react-native"
import semver from "semver"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {useAuth} from "@/contexts/AuthContext"
import {useDeeplink} from "@/contexts/DeeplinkContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import mantle from "@/services/MantleManager"
import {SETTINGS, engine, useSetting, BgTimer} from "@mentra/engine"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {APP_STORE_URL, PLAY_STORE_URL} from "@/constants/appConfig"
import {resolvedEndpoints} from "@/services/cloudClient"
import {fetchMinimumClientVersion} from "@/utils/cloudVersion"
import {useDeployment} from "@/services/deployment"

// Types
type ScreenState = "loading" | "connection" | "auth" | "outdated" | "success"

interface StatusConfig {
  icon: string
  iconColor: string
  title: string
  description: string
}

// Constants
const NAVIGATION_DELAY = 300
const DEEPLINK_DELAY = 1000

export default function InitScreen() {
  // Hooks
  const {theme} = useAppTheme()
  const {user, session, loading: authLoading} = useAuth()
  const {replace, replaceAll, getPendingRoute, setPendingRoute, clearHistoryAndGoHome, setAnimation} =
    useNavigationStore.getState()
  const {processUrl} = useDeeplink()
  const {activeDeployment, selectionResolved, store: deploymentStore} = useDeployment()
  const rootNavigationState = useRootNavigationState()
  const isNavigationReady = rootNavigationState?.key != null

  // State
  const initStartedRef = useRef(false)
  const [state, setState] = useState<ScreenState>("loading")
  const [localVersion, setLocalVersion] = useState<string | null>(null)
  const [cloudVersion, setCloudVersion] = useState<string | null>(null)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isUsingCustomUrl, setIsUsingCustomUrl] = useState(false)
  const [canSkipUpdate, setCanSkipUpdate] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [isBlockedByVersion, setIsBlockedByVersion] = useState(false)
  // Zustand store hooks
  // Runtime is the canonical boot version-policy service. Core keeps its
  // legacy endpoint only for already-released clients.
  const [, setCoreUrl] = useSetting(SETTINGS.cloud_core_url.key)
  const [runtimeUrl, setRuntimeUrl] = useSetting(SETTINGS.cloud_runtime_url.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [appBootExtraInfo] = useSetting(SETTINGS.app_boot_extra_info.key)
  const [bootPhase, setBootPhase] = useState<string>("Starting up…")
  const [cachedRequiredVersion, setCachedRequiredVersion] = useSetting(SETTINGS.cached_required_version.key)
  const updateUrl =
    activeDeployment.kind === "workspace"
      ? Platform.OS === "ios"
        ? activeDeployment.manifest.appUpdates.storeUrls.ios
        : activeDeployment.manifest.appUpdates.storeUrls.android
      : Platform.OS === "ios"
        ? APP_STORE_URL
        : PLAY_STORE_URL

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
    if (activeDeployment.kind === "workspace") {
      setIsUsingCustomUrl(true)
      return true
    }
    const defaultCoreUrl = SETTINGS[SETTINGS.cloud_core_url.key].defaultValue()
    const defaultRuntimeUrl = SETTINGS[SETTINGS.cloud_runtime_url.key].defaultValue()
    // Read directly from the store to avoid stale React closure values
    const currentCoreUrl = engine.settings.get(SETTINGS.cloud_core_url.key)
    const currentRuntimeUrl = engine.settings.get(SETTINGS.cloud_runtime_url.key)
    const isCustom = currentCoreUrl !== defaultCoreUrl || currentRuntimeUrl !== defaultRuntimeUrl
    setIsUsingCustomUrl(isCustom)
    return isCustom
  }

  const setAnimationDelayed = () => {
    BgTimer.setTimeout(() => {
      setAnimation("simple_push")
    }, 800)
  }

  useEffect(() => {
    console.log("INDEX: MOUNTED")
    return () => console.log("INDEX: UNMOUNTED")
  }, [])

  const navigateToDestination = useCallback(async () => {
    console.log("INDEX: navigateToDestination()")
    if (!user?.id) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace(activeDeployment.kind === "workspace" ? "/auth/workspace-signin" : "/auth/start", {
        transition: "fade",
      })
      return
    }

    // Read directly from the store so we see values that mantle.init() just
    // loaded from the server, regardless of React render timing.
    const onboardingDone = engine.settings.get(SETTINGS.onboarding_completed.key)
    const wearable = engine.settings.get(SETTINGS.default_wearable.key)

    if (!onboardingDone && !wearable) {
      await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
      replace("/onboarding/welcome", {transition: "fade"})
      return
    }

    const pendingRoute = getPendingRoute()
    if (pendingRoute) {
      setPendingRoute(null)
      // Navigate to home first so the deep link screen has a proper back destination
      clearHistoryAndGoHome({transition: "none"})
      setTimeout(() => processUrl(pendingRoute), DEEPLINK_DELAY)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_DELAY))
    setAnimationDelayed()
    clearHistoryAndGoHome({transition: "none"})
  }, [user, getPendingRoute, processUrl, clearHistoryAndGoHome, replace, replaceAll, setPendingRoute, setAnimation])

  const checkLoggedIn = async (): Promise<void> => {
    if (!user) {
      replaceAll(activeDeployment.kind === "workspace" ? "/auth/workspace-signin" : "/auth/start")
      return
    }
    handleTokenExchange()
  }

  const handleTokenExchange = async (): Promise<void> => {
    console.log("INDEX: handleTokenExchange()")
    // Cloud V2 cutover (issue 019): the app holds V2 tokens directly. There is no
    // legacy Cloud V1 exchange; cloud-client obtains and exchanges a subject token
    // itself via the auth provider. Boot just needs a valid session, then init.
    const token = session?.token
    if (!token) {
      if (activeDeployment.kind === "workspace") {
        replaceAll("/auth/workspace-signin")
        return
      }
      setState("auth")
      return
    }

    setBootPhase("Initializing core…")
    await mantle.init()

    setBootPhase("Navigating…")
    await navigateToDestination()
  }

  const checkCloudVersion = async (isRetry = false): Promise<void> => {
    // Only show loading screen on initial load, not on retry
    if (!isRetry) {
      setState("loading")
    } else {
      setIsRetrying(true)
    }
    setBootPhase("Checking for updates…")

    const localVer = getLocalVersion()
    console.log("INDEX: Local version:", localVer)

    if (!localVer) {
      console.error("Failed to get local version")
      setState("connection")
      setIsRetrying(false)
      return
    }

    const versionRuntimeUrl =
      activeDeployment.kind === "workspace"
        ? activeDeployment.manifest.services.runtimeUrl!
        : resolvedEndpoints().runtime
    const cachedVersion = activeDeployment.kind === "consumer" ? cachedRequiredVersion : null

    // Runtime serves the policy before authentication. Retries cover boot-time
    // DNS blips that would otherwise dump users at the connection screen.
    const res = await fetchMinimumClientVersion(versionRuntimeUrl, 3, 1000)
    if (res.is_error()) {
      console.error("Failed to fetch minimum client version:", res.error)

      // Even offline, check cached required version to block outdated apps
      if (cachedVersion && semver.lt(localVer, cachedVersion)) {
        console.log(`INDEX: Offline but app is below cached required version (${localVer} < ${cachedVersion})`)
        setLocalVersion(localVer)
        setCloudVersion(cachedVersion)
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
    console.log(`INDEX: Version check: local=${localVer}, required=${required}, recommended=${recommended}`)

    // Cache the required version for offline enforcement
    if (activeDeployment.kind === "consumer" && required && required !== cachedRequiredVersion) {
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
    if (!updateUrl) return
    setIsUpdating(true)
    try {
      await Linking.openURL(updateUrl)
    } catch (error) {
      console.error("Error opening store:", error)
    } finally {
      setIsUpdating(false)
    }
  }

  const handleResetUrl = async (): Promise<void> => {
    try {
      if (activeDeployment.kind === "workspace") {
        deploymentStore.returnToMentra()
        replaceAll("/auth/start")
        return
      }
      const defaultCoreUrl = SETTINGS[SETTINGS.cloud_core_url.key].defaultValue()
      const defaultRuntimeUrl = SETTINGS[SETTINGS.cloud_runtime_url.key].defaultValue()
      await Promise.all([setCoreUrl(defaultCoreUrl), setRuntimeUrl(defaultRuntimeUrl)])
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
    console.log("INDEX: USE EFFECT: authLoading, isNavigationReady:", authLoading, isNavigationReady)
    if (authLoading || !isNavigationReady) return
    if (initStartedRef.current) return
    initStartedRef.current = true

    // A fresh install has not selected Mentra or a customer workspace yet.
    // Render the local selector without performing Mentra's cloud version call.
    if (!selectionResolved) {
      replaceAll("/auth/start")
      return
    }

    const init = async () => {
      console.log("INDEX: init()")
      await checkCustomUrl()
      await checkCloudVersion()
    }
    init()
  }, [authLoading, isNavigationReady, selectionResolved])

  // Clear the legacy consumer cache when its Runtime changes so a stricter
  // server's requirement doesn't block access to a different backend.
  // Skip the initial mount so the cached value is preserved for offline enforcement.
  const runtimeUrlRef = useRef(runtimeUrl)
  useEffect(() => {
    if (runtimeUrlRef.current !== runtimeUrl) {
      runtimeUrlRef.current = runtimeUrl
      if (cachedRequiredVersion) {
        setCachedRequiredVersion("")
      }
    }
  }, [runtimeUrl])

  useEffect(() => {
    setAnimation("fade")
  }, [])

  // Render
  if (state === "loading") {
    return (
      <Screen preset="fixed">
        <SplashVideo label={appBootExtraInfo ? bootPhase : undefined} />
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

        {state === "outdated" && updateUrl && (
          <Button
            flexContainer
            preset="primary"
            onPress={handleUpdate}
            disabled={isUpdating}
            tx={canSkipUpdate ? "versionCheck:update" : "versionCheck:updateRequiredButton"}
          />
        )}

        {(state === "connection" || state === "auth" || state === "outdated") && isUsingCustomUrl && (
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
