import {useLocalSearchParams} from "expo-router"
import {useEffect, useMemo, useRef, useState} from "react"
import {Animated, Platform, TextStyle, View, ViewStyle} from "react-native"
import Toast from "react-native-toast-message"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

import {Header, Icon, Screen, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import LoadingOverlay from "@/components/ui/LoadingOverlay"
import Divider from "@/components/ui/Divider"
import InfoCardSection from "@/components/ui/InfoCard"
import {RouteButton} from "@/components/ui/RouteButton"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {engine, isSystemMiniappPackage, useApps, useRefresh} from "@mentra/engine"

import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {captureRef} from "react-native-view-shot"

// App info screen for installed (local/offline) miniapps. The Cloud V1
// app-settings machinery that used to live here (server-fetched setting
// controls, webview redirect, V1 uninstall endpoints) was removed with
// Cloud V1 app end-of-life; everything on this screen is served by the
// island app store.
export default function AppSettings() {
  const {packageName, appName: appNameParam} = useLocalSearchParams<{packageName: string; appName?: string}>()
  const [isUninstalling, setIsUninstalling] = useState(false)
  const {theme, themed} = useAppTheme()
  const {goBack, replaceAll} = useNavigationStore.getState()
  const insets = useSaferAreaInsets()

  // Use appName from params or default to empty string
  const appName = appNameParam || ""

  // Animation values for collapsing header
  const scrollY = useRef(new Animated.Value(0)).current
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 50, 100],
    outputRange: [0, 0, 1],
    extrapolate: "clamp",
  })

  const applets = useApps()
  const refreshApplets = useRefresh()

  const appInfo = useMemo(() => {
    return applets.find((app) => app.packageName === packageName) || null
  }, [applets, packageName])

  // Universal /apps/:packageName links can land here for packages that aren't
  // installed. Once the app list has loaded and the package was NEVER found,
  // fall back to home with a toast instead of a blank screen. `everFound` keeps
  // the normal uninstall flow (appInfo disappears after a successful uninstall)
  // out of this fallback.
  const everFoundRef = useRef(false)
  if (appInfo) {
    everFoundRef.current = true
  }
  // "Loaded" must come from the registry refresh completing, not from
  // `applets.length > 0` — a user with zero installed apps would otherwise
  // never trigger the fallback and sit on a blank screen.
  const [appsLoaded, setAppsLoaded] = useState(applets.length > 0)
  useEffect(() => {
    let cancelled = false
    Promise.resolve(refreshApplets()).finally(() => {
      if (!cancelled) setAppsLoaded(true)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (appsLoaded && !appInfo && !everFoundRef.current) {
      Toast.show({type: "error", text1: translate("appInfo:notInstalled"), text2: packageName})
      replaceAll("/home")
    }
  }, [appsLoaded, appInfo, packageName, replaceAll])

  const uninstallable = Boolean(appInfo && !appInfo.offline && !isSystemMiniappPackage(packageName))

  const viewShotRef = useRef(null)
  const saveScreenshot = async () => {
    try {
      const uri = await captureRef(viewShotRef, {
        format: "jpg",
        quality: 0.5,
      })
      console.log("saving screenshot for", packageName)
      await engine.miniapps.saveScreenshot(packageName as string, uri)
    } catch (e) {
      console.warn("screenshot failed:", e)
    }
  }
  const handleExit = async () => {
    await saveScreenshot()
    goBack()
  }
  focusEffectPreventBack(() => {
    console.log("SETTINGS: focusEffectPreventBack() called")
    // On iOS, iosDontPreventBack=true lets the native gesture handle navigation,
    // so we only need to capture the screenshot. On Android, preventBack is still
    // true so we must also call goBack() to navigate.
    saveScreenshot()
    if (Platform.OS === "android") {
      goBack()
    }
  }, true)

  const handleUninstallApp = () => {
    console.log(`Uninstalling app: ${packageName}`)

    showAlert(
      translate("appSettings:uninstallApp"),
      translate("appSettings:uninstallConfirm", {appName: appInfo?.name || appName}),
      [
        {
          text: translate("common:cancel"),
          style: "cancel",
        },
        {
          text: translate("appSettings:uninstall"),
          style: "destructive",
          onPress: async () => {
            try {
              setIsUninstalling(true)
              // First stop the app if it's running
              if (appInfo?.running) {
                await engine.miniapps.stop(packageName)
              }

              // Then uninstall it via the island app store
              const res = await engine.miniapps.uninstall(packageName)
              if (res.is_error()) {
                throw res.error
              }

              // Show success message and navigate after dismissal
              showAlert(
                translate("common:success"),
                translate("appSettings:uninstalledSuccess", {appName: appInfo?.name || appName}),
                [{text: translate("common:ok"), onPress: () => replaceAll("/home")}],
              )
            } catch (error: any) {
              console.error("Error uninstalling app:", error)
              refreshApplets()
              showAlert(
                translate("common:error"),
                translate("appSettings:uninstallError", {error: error.message || "Unknown error"}),
                [{text: translate("common:ok")}],
              )
            } finally {
              setIsUninstalling(false)
            }
          },
        },
      ],
      {
        iconName: "trash",
        iconSize: 48,
      },
    )
  }

  if (!appInfo) {
    // Optionally, you could render a fallback error or nothing
    return null
  }

  if (!packageName || typeof packageName !== "string") {
    console.error("No packageName found in params")
    return null
  }

  return (
    <Screen preset="fixed" ref={viewShotRef}>
      {isUninstalling && <LoadingOverlay message={`Uninstalling ${appInfo?.name || appName}...`} />}

      <View>
        <Header title="" leftIcon="chevron-left" onLeftPress={handleExit} />
        <Animated.View
          style={{
            opacity: headerOpacity,
            position: "absolute",
            top: insets.top,
            left: 0,
            right: 0,
            height: 56,
            justifyContent: "center",
            alignItems: "center",
            pointerEvents: "none",
          }}>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              color: theme.colors.text,
            }}
            numberOfLines={1}
            ellipsizeMode="tail">
            {appInfo?.name || (appName as string)}
          </Text>
        </Animated.View>
      </View>

      <Animated.ScrollView
        style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        onScroll={Animated.event([{nativeEvent: {contentOffset: {y: scrollY}}}], {useNativeDriver: true})}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled">
        <View style={{gap: theme.spacing.s6}}>
          {/* Combined App Info and Action Section */}
          <View style={themed($topSection)}>
            <AppIcon app={appInfo} style={themed($appIconLarge)} />

            <View style={themed($rightColumn)}>
              <View style={themed($textContainer)}>
                <Text style={themed($appNameSmall)}>{appInfo.name}</Text>
                {appInfo.version && <Text style={themed($versionText)}>{appInfo.version}</Text>}
              </View>
            </View>
          </View>

          {!appInfo.healthy && !appInfo.offline && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.spacing.s2,
                backgroundColor: theme.colors.errorBackground,
                borderRadius: 8,
                paddingHorizontal: theme.spacing.s3,
                paddingVertical: theme.spacing.s2,
              }}>
              <Icon name="alert" size={16} color={theme.colors.error} />
              <Text style={{color: theme.colors.error, flex: 1}}>{translate("appSettings:appOfflineWarning")}</Text>
            </View>
          )}

          <Divider variant="full" />

          {/* Description Section */}
          <View style={themed($descriptionSection)}>
            <Text style={themed($descriptionText)}>{translate("appSettings:noDescription")}</Text>
          </View>

          <Divider variant="full" />

          {/* Additional Information Section */}
          <View>
            <Text style={themed($sectionTitleText)}>{translate("appSettings:appInfo")}</Text>
            <InfoCardSection
              items={[
                {
                  label: translate("appSettings:appType"),
                  value:
                    appInfo?.type === "standard"
                      ? translate("appSettings:foreground")
                      : appInfo?.type === "background"
                        ? translate("appSettings:background")
                        : "—",
                },
                {
                  label: translate("appSettings:packageName"),
                  value: packageName,
                },
              ]}
            />
          </View>

          {/* Uninstall Button at the bottom */}
          <RouteButton
            label={translate("appSettings:uninstall")}
            preset="destructive"
            onPress={() => {
              if (uninstallable) {
                handleUninstallApp()
              } else {
                showAlert(translate("appSettings:cannotUninstall"), translate("appSettings:cannotUninstallMessage"), [
                  {text: translate("common:ok"), style: "default"},
                ])
              }
            }}
            disabled={!uninstallable}
          />

          {/* Bottom safe area padding */}
          <View style={{height: Math.max(40, insets.bottom + 20)}} />
        </View>
      </Animated.ScrollView>
    </Screen>
  )
}

const $topSection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s6,
  alignItems: "center",
})

const $rightColumn: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "space-between",
})

const $textContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s1,
})

const $appIconLarge: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: 90,
  height: 90,
  borderRadius: spacing.s6, // Squircle-friendly radius
})

const $appNameSmall: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 24,
  fontWeight: "600",
  fontFamily: "Montserrat-Bold",
  color: colors.text,
})

const $versionText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontFamily: "Montserrat-Regular",
  color: colors.textDim,
})

const $descriptionSection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingVertical: spacing.s2,
  paddingHorizontal: spacing.s4,
})

const $descriptionText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontFamily: "Montserrat-Regular",
  lineHeight: 22,
  color: colors.text,
})

const $sectionTitleText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.text,
  lineHeight: 20,
  letterSpacing: 0,
  marginBottom: spacing.s2,
  marginTop: spacing.s3,
})
