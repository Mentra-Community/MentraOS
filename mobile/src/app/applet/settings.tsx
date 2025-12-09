import {useFocusEffect, useLocalSearchParams} from "expo-router"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Animated, BackHandler, TextStyle, View, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import Toast from "react-native-toast-message"

import {Header, Icon, PillButton, Screen, Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import LoadingOverlay from "@/components/misc/LoadingOverlay"
import SettingsSkeleton from "@/components/misc/SettingsSkeleton"
import GroupTitle from "@/components/settings/GroupTitle"
import MultiSelectSetting from "@/components/settings/MultiSelectSetting"
import NumberSetting from "@/components/settings/NumberSetting"
import SelectSetting from "@/components/settings/SelectSetting"
import SelectWithSearchSetting from "@/components/settings/SelectWithSearchSetting"
import SliderSetting from "@/components/settings/SliderSetting"
import TextSettingNoSave from "@/components/settings/TextSettingNoSave"
import TimeSetting from "@/components/settings/TimeSetting"
import TitleValueSetting from "@/components/settings/TitleValueSetting"
import ToggleSetting from "@/components/settings/ToggleSetting"
import Divider from "@/components/ui/Divider"
import InfoCardSection from "@/components/ui/InfoCard"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import {useApplets, useRefreshApplets, useStartApplet, useStopApplet} from "@/stores/applets"
import {$styles, ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {storage} from "@/utils/storage"
import {useAppTheme} from "@/utils/useAppTheme"

export default function AppSettings() {
  const {packageName, appName: appNameParam} = useLocalSearchParams()
  const [isUninstalling, setIsUninstalling] = useState(false)
  const {theme, themed} = useAppTheme()
  const {goBack, replace} = useNavigationHistory()
  const insets = useSafeAreaInsets()
  const hasLoadedData = useRef(false)

  // Use appName from params or default to empty string
  const [appName, setAppName] = useState(appNameParam || "")

  // Animation values for collapsing header
  const scrollY = useRef(new Animated.Value(0)).current
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 50, 100],
    outputRange: [0, 0, 1],
    extrapolate: "clamp",
  })

  // State to hold the complete configuration from the server.
  const [serverAppInfo, setServerAppInfo] = useState<any>(null)
  // Local state to track current values for each setting.
  const [settingsState, setSettingsState] = useState<{[key: string]: any}>({})

  const startApp = useStartApplet()
  const applets = useApplets()
  const refreshApplets = useRefreshApplets()
  const stopApp = useStopApplet()

  const appInfo = useMemo(() => {
    return applets.find(app => app.packageName === packageName) || null
  }, [applets, packageName])

  const SETTINGS_CACHE_KEY = (packageName: string) => `app_settings_cache_${packageName}`
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [hasCachedSettings, setHasCachedSettings] = useState(false)

  // Handle app start/stop actions with debouncing
  const handleStartStopApp = async () => {
    if (!appInfo) return

    try {
      if (appInfo.running) {
        stopApp(packageName)
        return
      }

      // If the app appears offline, confirm before proceeding
      if (!appInfo.healthy) {
        const developerName = (
          " " +
          ((serverAppInfo as any)?.organization?.name ||
            (appInfo as any).orgName ||
            (appInfo as any).developerId ||
            "") +
          " "
        ).replace("  ", " ")
        const proceed = await new Promise<boolean>(resolve => {
          // Use the shared alert utility
          showAlert(
            translate("appSettings:appDownForMaintenance"),
            translate("appSettings:appOfflineMessage", {appName: appInfo.name, developerName}),
            [
              {text: translate("common:cancel"), style: "cancel", onPress: () => resolve(false)},
              {text: translate("appSettings:tryAnyway"), onPress: () => resolve(true)},
            ],
            {iconName: "alert-circle-outline", iconColor: theme.colors.palette.angry500},
          )
        })
        if (!proceed) return
      }

      const health = await restComms.checkAppHealthStatus(appInfo.packageName)
      if (health.is_error() || !health.value) {
        showAlert(translate("errors:appNotOnlineTitle"), translate("errors:appNotOnlineMessage"), [
          {text: translate("common:ok")},
        ])
        return
      }

      // ask for needed perms:
      const result = await askPermissionsUI(appInfo, theme)
      if (result === -1) {
        return
      } else if (result === 0) {
        handleStartStopApp() // restart this function
        return
      }

      startApp(packageName)
    } catch (error) {
      // Refresh the app status to get the accurate state from the server
      refreshApplets()

      console.error(`Error ${appInfo.running ? "stopping" : "starting"} app:`, error)
    }
  }

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
                // Optimistically update UI first
                stopApp(packageName)
                await restComms.stopApp(packageName)
              }

              // Then uninstall it
              await restComms.uninstallApp(packageName)

              // Show success message
              Toast.show({
                type: "success",
                text1: translate("appSettings:uninstalledSuccess", {appName: appInfo?.name || appName}),
              })

              replace("/(tabs)/home")
            } catch (error: any) {
              console.error("Error uninstalling app:", error)
              refreshApplets()
              Toast.show({
                type: "error",
                text1: translate("appSettings:uninstallError", {error: error.message || "Unknown error"}),
              })
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

  const fetchUpdatedSettingsInfo = async () => {
    // Only show skeleton if there are no cached settings
    if (!hasCachedSettings) setSettingsLoading(true)
    const startTime = Date.now() // For profiling
    try {
      const res = await restComms.getAppSettings(packageName)

      const elapsed = Date.now() - startTime
      console.log(`[PROFILE] getTpaSettings for ${packageName} took ${elapsed}ms`)
      console.log("GOT TPA SETTING")
      // TODO: Profile backend and optimize if slow
      // If no data is returned from the server, create a minimal app info object
      if (res.is_error()) {
        setServerAppInfo({
          name: appInfo?.name || appName,
          description: translate("appSettings:noDescription"),
          settings: [],
          uninstallable: true,
        })
        setSettingsState({})
        setHasCachedSettings(false)
        setSettingsLoading(false)
        return
      }
      const data: any = res.value
      setServerAppInfo(data)

      console.log("GOT TPA SETTING", JSON.stringify(data))

      // Update appName if we got it from server
      if (data.name) {
        setAppName(data.name)
      }

      // Initialize local state using the "selected" property.
      if (data.settings && Array.isArray(data.settings)) {
        const initialState: {[key: string]: any} = {}
        data.settings.forEach((setting: any) => {
          if (setting.type !== "group") {
            // Use cached value if it exists (user has interacted with this setting before)
            // Otherwise use 'selected' from backend (which includes defaultValue for new settings)
            initialState[setting.key] = setting.selected
          }
        })
        setSettingsState(initialState)
        // Cache the settings
        storage.save(SETTINGS_CACHE_KEY(packageName), {
          serverAppInfo: data,
          settingsState: initialState,
        })
        setHasCachedSettings(data.settings.length > 0)
      } else {
        setHasCachedSettings(false)
      }
      setSettingsLoading(false)

      // TACTICAL BYPASS: Execute immediate webview redirect if webviewURL detected
      // if (data.webviewURL && fromWebView !== "true") {
      //   replace("/applet/webview", {
      //     webviewURL: data.webviewURL,
      //     appName: appName,
      //     packageName: packageName,
      //   })
      //   return
      // }
    } catch (err) {
      setSettingsLoading(false)
      setHasCachedSettings(false)
      console.error("Error fetching App settings:", err)
      setServerAppInfo({
        name: appInfo?.name || appName,
        description: translate("appSettings:noDescription"),
        settings: [],
        uninstallable: true,
      })
      setSettingsState({})
    }
  }

  // When a setting changes, update local state and send the full updated settings payload.
  const handleSettingChange = (key: string, value: any) => {
    setSettingsState(prevState => ({
      ...prevState,
      [key]: value,
    }))

    // Build an array of settings to send.
    restComms
      .updateAppSetting(packageName, {key, value})
      .then(data => {
        console.log("Server update response:", data)
      })
      .catch(error => {
        console.error("Error updating setting on server:", error)
      })
  }

  // Pre-process settings into groups for proper isFirst/isLast styling
  const processedSettings = useMemo(() => {
    if (!serverAppInfo?.settings) return []

    const settings = serverAppInfo.settings
    const result: Array<{setting: any; isFirst: boolean; isLast: boolean; isGrouped: boolean}> = []
    let currentGroupStart = -1

    for (let i = 0; i < settings.length; i++) {
      const setting = settings[i]

      if (setting.type === "group") {
        // Close previous group if exists
        if (currentGroupStart !== -1 && result.length > 0) {
          // Find last non-group setting and mark as last
          for (let j = result.length - 1; j >= 0; j--) {
            if (result[j].isGrouped) {
              result[j].isLast = true
              break
            }
          }
        }
        // Add group title (not styled as grouped)
        result.push({setting, isFirst: false, isLast: false, isGrouped: false})
        currentGroupStart = result.length
      } else {
        // Check if this is the first setting after a group title or at the start
        const isFirstInGroup =
          currentGroupStart === result.length ||
          (currentGroupStart === -1 && result.filter(r => r.isGrouped).length === 0)

        // Check if next is a group or end
        const nextSetting = settings[i + 1]
        const isLastInGroup = !nextSetting || nextSetting.type === "group"

        result.push({
          setting,
          isFirst: isFirstInGroup,
          isLast: isLastInGroup,
          isGrouped: true,
        })
      }
    }

    return result
  }, [serverAppInfo?.settings])

  // Render each setting.
  const renderSetting = (setting: any, isFirst: boolean, isLast: boolean, index: number) => {
    switch (setting.type) {
      case "group":
        return <GroupTitle key={`group-${index}`} title={setting.title} />
      case "toggle":
        return (
          <ToggleSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            onValueChange={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "text":
        return (
          <TextSettingNoSave
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            onChangeText={text => handleSettingChange(setting.key, text)}
            settingKey={setting.key}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "text_no_save_button":
        return (
          <TextSettingNoSave
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            onChangeText={text => handleSettingChange(setting.key, text)}
            settingKey={setting.key}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "slider":
        return (
          <SliderSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            min={setting.min}
            max={setting.max}
            onValueChange={val =>
              setSettingsState(prevState => ({
                ...prevState,
                [setting.key]: val,
              }))
            }
            onValueSet={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "select":
        return (
          <SelectSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            options={setting.options}
            defaultValue={setting.defaultValue}
            onValueChange={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "select_with_search":
        return (
          <SelectWithSearchSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            options={setting.options}
            defaultValue={setting.defaultValue}
            onValueChange={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "numeric_input":
        return (
          <NumberSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key] || 0}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            placeholder={setting.placeholder}
            onValueChange={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "time_picker":
        return (
          <TimeSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key] || 0}
            showSeconds={setting.showSeconds !== false}
            onValueChange={val => handleSettingChange(setting.key, val)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "multiselect":
        return (
          <MultiSelectSetting
            key={index}
            label={setting.label}
            values={settingsState[setting.key]}
            options={setting.options}
            onValueChange={vals => handleSettingChange(setting.key, vals)}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      case "titleValue":
        return (
          <TitleValueSetting
            key={index}
            label={setting.label}
            value={setting.value}
            isFirst={isFirst}
            isLast={isLast}
          />
        )
      default:
        return null
    }
  }

  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        goBack()
        return true
      }
      const subscription = BackHandler.addEventListener("hardwareBackPress", onBackPress)
      return () => {
        subscription.remove()
      }
    }, [goBack]),
  )

  // Reset hasLoadedData when packageName changes
  useEffect(() => {
    hasLoadedData.current = false
  }, [packageName])

  // Fetch App settings on mount
  useEffect(() => {
    // Skip if we've already loaded data for this packageName
    if (hasLoadedData.current) {
      return
    }

    let isMounted = true
    let debounceTimeout: NodeJS.Timeout

    const loadCachedSettings = async () => {
      const res = await storage.load(SETTINGS_CACHE_KEY(packageName))
      if (res.is_error()) {
        setHasCachedSettings(false)
        setSettingsLoading(true)
        return
      }
      const cached: any = res.value
      if (!isMounted) {
        return
      }

      setServerAppInfo(cached.serverAppInfo)
      setSettingsState(cached.settingsState)
      setHasCachedSettings(!!(cached.serverAppInfo?.settings && cached.serverAppInfo.settings.length > 0))
      setSettingsLoading(false)

      // Update appName from cached data if available
      if (cached.serverAppInfo?.name) {
        setAppName(cached.serverAppInfo.name)
      }

      // TACTICAL BYPASS: If webviewURL exists in cached data, execute immediate redirect
      // if (cached.serverAppInfo?.webviewURL && fromWebView !== "true") {
      //   replace("/applet/webview", {
      //     webviewURL: cached.serverAppInfo.webviewURL,
      //     appName: appName,
      //     packageName: packageName,
      //   })
      //   return
      // }
    }

    // Load cached settings immediately
    loadCachedSettings()

    // Debounce fetch to avoid redundant calls
    debounceTimeout = setTimeout(() => {
      fetchUpdatedSettingsInfo()
      hasLoadedData.current = true
    }, 150)

    return () => {
      isMounted = false
      clearTimeout(debounceTimeout)
    }
  }, [])

  if (!appInfo) {
    // Optionally, you could render a fallback error or nothing
    return null
  }

  if (!packageName || typeof packageName !== "string") {
    console.error("No packageName found in params")
    return null
  }

  return (
    <Screen preset="fixed" safeAreaEdges={[]} style={themed($styles.screen)}>
      {isUninstalling && <LoadingOverlay message={`Uninstalling ${appInfo?.name || appName}...`} />}

      <View>
        <Header title="" leftIcon="chevron-left" onLeftPress={() => goBack()} />
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

      {/* <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{flex: 1}}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}> */}
      <Animated.ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
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
                {serverAppInfo?.version && (
                  <Text style={themed($versionText)}>{serverAppInfo?.version || "1.0.0"}</Text>
                )}
              </View>
              <View style={themed($buttonContainer)}>
                <PillButton
                  text={appInfo.running ? translate("common:stop") : translate("common:start")}
                  onPress={handleStartStopApp}
                  variant="icon"
                  buttonStyle={{paddingHorizontal: theme.spacing.s6, minWidth: 80}}
                />
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
            <Text style={themed($descriptionText)}>
              {serverAppInfo?.description || translate("appSettings:noDescription")}
            </Text>
          </View>

          <Divider variant="full" />

          {/* App Instructions Section */}
          {serverAppInfo?.instructions && (
            <View style={themed($sectionContainer)}>
              <Text style={themed($sectionTitle)}>{translate("appSettings:aboutThisApp")}</Text>
              <Text style={themed($instructionsText)}>{serverAppInfo.instructions}</Text>
            </View>
          )}

          {/* App Settings Section */}
          <View style={themed($settingsContainer)}>
            {settingsLoading && (!serverAppInfo?.settings || typeof serverAppInfo.settings === "undefined") ? (
              <SettingsSkeleton />
            ) : processedSettings.length > 0 ? (
              processedSettings.map(({setting, isFirst, isLast}, index) =>
                renderSetting(setting, isFirst, isLast, index),
              )
            ) : (
              <Text style={themed($noSettingsText)}>{translate("appSettings:noSettings")}</Text>
            )}
          </View>

          {/* Additional Information Section */}
          <View>
            <Text style={themed($sectionTitleText)}>{translate("appSettings:appInfo")}</Text>
            <InfoCardSection
              items={[
                {
                  label: translate("appSettings:company"),
                  value: serverAppInfo?.organization?.name || "—",
                },
                {
                  label: translate("appSettings:website"),
                  value: serverAppInfo?.organization?.website || "—",
                },
                {
                  label: translate("appSettings:contact"),
                  value: serverAppInfo?.organization?.contactEmail || "—",
                },
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
            variant="destructive"
            onPress={() => {
              if (serverAppInfo?.uninstallable) {
                handleUninstallApp()
              } else {
                showAlert(translate("appSettings:cannotUninstall"), translate("appSettings:cannotUninstallMessage"), [
                  {text: translate("common:ok"), style: "default"},
                ])
              }
            }}
            disabled={!serverAppInfo?.uninstallable}
          />

          {/* Bottom safe area padding */}
          <View style={{height: Math.max(40, insets.bottom + 20)}} />
        </View>
      </Animated.ScrollView>
      {/* </KeyboardAvoidingView> */}
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

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignSelf: "flex-start",
  marginTop: spacing.s3,
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

const $sectionContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  borderRadius: spacing.s3,
  borderWidth: 1,
  padding: spacing.s4,
  elevation: 2,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.1,
  shadowRadius: spacing.s1,
  backgroundColor: colors.background,
  borderColor: colors.border,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 18,
  fontWeight: "bold",
  fontFamily: "Montserrat-Bold",
  marginBottom: spacing.s3,
  color: colors.text,
})

const $instructionsText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  lineHeight: 22,
  fontFamily: "Montserrat-Regular",
  color: colors.text,
})

const $settingsContainer: ThemedStyle<ViewStyle> = () => ({
  // Gap is handled by individual settings via isFirst/isLast marginBottom
})

const $noSettingsText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontFamily: "Montserrat-Regular",
  fontStyle: "italic",
  textAlign: "center",
  padding: spacing.s4,
  color: colors.textDim,
})

const _$groupTitle: ThemedStyle<TextStyle> = () => ({})

const $sectionTitleText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  color: colors.text,
  lineHeight: 20,
  letterSpacing: 0,
  marginBottom: spacing.s2,
  marginTop: spacing.s3,
})
