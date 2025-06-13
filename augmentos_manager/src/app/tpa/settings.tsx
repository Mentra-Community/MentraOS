// src/AppSettings.tsx
import React, {useEffect, useState, useMemo, useLayoutEffect, useCallback, useRef} from "react"
import {View, Text, StyleSheet, TouchableOpacity, ScrollView, ViewStyle, TextStyle, Animated} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import GroupTitle from "@/components/settings/GroupTitle"
import ToggleSetting from "@/components/settings/ToggleSetting"
import TextSettingNoSave from "@/components/settings/TextSettingNoSave"
import SliderSetting from "@/components/settings/SliderSetting"
import SelectSetting from "@/components/settings/SelectSetting"
import MultiSelectSetting from "@/components/settings/MultiSelectSetting"
import TitleValueSetting from "@/components/settings/TitleValueSetting"
import LoadingOverlay from "@/components/misc/LoadingOverlay"
import {useStatus} from "@/contexts/AugmentOSStatusProvider"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import FontAwesome from "react-native-vector-icons/FontAwesome"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import AppIcon from "@/components/misc/AppIcon"
import SelectWithSearchSetting from "@/components/settings/SelectWithSearchSetting"
import {saveSetting, loadSetting} from "@/utils/SettingsHelper"
import SettingsSkeleton from "@/components/misc/SettingsSkeleton"
import {router, useFocusEffect, useLocalSearchParams} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {Header, Screen, PillButton} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext"
import ActionButton from "@/components/ui/ActionButton"
import Divider from "@/components/misc/Divider"
import { InfoRow } from "@/components/settings/InfoRow"
import { SettingsGroup } from "@/components/settings/SettingsGroup"
import { showAlert } from "@/utils/AlertUtils"

export default function AppSettings() {
  const {packageName, appName, fromWebView} = useLocalSearchParams()
  const backendServerComms = BackendServerComms.getInstance()
  const [isUninstalling, setIsUninstalling] = useState(false)
  const {theme, themed} = useAppTheme()
  const {goBack, push, replace} = useNavigationHistory()
  const insets = useSafeAreaInsets()
  
  // Animation values for collapsing header
  const scrollY = useRef(new Animated.Value(0)).current
  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 50, 100],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  })
  if (!packageName || !appName || typeof packageName !== "string" || typeof appName !== "string") {
    console.error("No packageName or appName found in params")
    return null
  }

  // State to hold the complete configuration from the server.
  const [serverAppInfo, setServerAppInfo] = useState<any>(null)
  // Local state to track current values for each setting.
  const [settingsState, setSettingsState] = useState<{[key: string]: any}>({})
  // Get app info from status
  const {status} = useStatus()
  const {appStatus, refreshAppStatus, optimisticallyStartApp, optimisticallyStopApp, clearPendingOperation} =
    useAppStatus()
  const appInfo = useMemo(() => {
    return appStatus.find(app => app.packageName === packageName) || null
  }, [appStatus, packageName])

  const SETTINGS_CACHE_KEY = (packageName: string) => `app_settings_cache_${packageName}`
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [hasCachedSettings, setHasCachedSettings] = useState(false)

  // propagate any changes in app lists when this screen is unmounted:
  useFocusEffect(
    useCallback(() => {
      return async () => {
        await refreshAppStatus()
      }
    }, []),
  )

  // Handle app start/stop actions with debouncing
  const handleStartStopApp = async () => {
    if (!appInfo) return

    console.log(`${appInfo.is_running ? "Stopping" : "Starting"} app: ${packageName}`)

    try {
      if (appInfo.is_running) {
        // Optimistically update UI first
        optimisticallyStopApp(packageName)

        // Then request the server to stop the app
        await backendServerComms.stopApp(packageName)

        // Clear the pending operation since it completed successfully
        clearPendingOperation(packageName)
      } else {
        // Optimistically update UI first
        optimisticallyStartApp(packageName)

        // Check if it's a standard app
        if (appInfo.tpaType === "standard") {
          // Find any running standard apps
          const runningStandardApps = appStatus.filter(
            app => app.is_running && app.tpaType === "standard" && app.packageName !== packageName,
          )

          // If there's any running standard app, stop it first
          for (const runningApp of runningStandardApps) {
            // Optimistically update UI
            optimisticallyStopApp(runningApp.packageName)

            try {
              await backendServerComms.stopApp(runningApp.packageName)
              clearPendingOperation(runningApp.packageName)
            } catch (error) {
              console.error("Stop app error:", error)
              refreshAppStatus()
            }
          }
        }

        // Then request the server to start the app
        await backendServerComms.startApp(packageName)

        // Clear the pending operation since it completed successfully
        clearPendingOperation(packageName)
      }
    } catch (error) {
      // Clear the pending operation for this app
      clearPendingOperation(packageName)

      // Refresh the app status to get the accurate state from the server
      refreshAppStatus()

      console.error(`Error ${appInfo.is_running ? "stopping" : "starting"} app:`, error)
    }
  }

  const handleUninstallApp = () => {
    console.log(`Uninstalling app: ${packageName}`)

    showAlert(
      "Uninstall App", 
      `Are you sure you want to uninstall ${appInfo?.name || appName}?`, 
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Uninstall",
          style: "destructive",
          onPress: async () => {
          try {
            setIsUninstalling(true)
            // First stop the app if it's running
            if (appInfo?.is_running) {
              // Optimistically update UI first
              optimisticallyStopApp(packageName)
              await backendServerComms.stopApp(packageName)
              clearPendingOperation(packageName)
            }

            // Then uninstall it
            await backendServerComms.uninstallApp(packageName)

            // Show success message
            GlobalEventEmitter.emit("SHOW_BANNER", {
              message: `${appInfo?.name || appName} has been uninstalled successfully`,
              type: "success",
            })
            
            goBack()
          } catch (error: any) {
            console.error("Error uninstalling app:", error)
            clearPendingOperation(packageName)
            refreshAppStatus()
            GlobalEventEmitter.emit("SHOW_BANNER", {
              message: `Error uninstalling app: ${error.message || "Unknown error"}`,
              type: "error",
            })
          } finally {
            setIsUninstalling(false)
          }
        },
      },
    ],
    {
      iconName: "delete-forever",
      iconSize: 48,
      iconColor: theme.colors.destructiveAction,
    }
  )
  }

  // Add header button when webviewURL exists
  useLayoutEffect(() => {
    if (serverAppInfo?.webviewURL) {
      // TODO2.0:
      // navigation.setOptions({
      //   headerRight: () => (
      //     <View style={{marginRight: 8}}>
      //       <FontAwesome.Button
      //         name="globe"
      //         size={22}
      //         color={isDarkTheme ? "#FFFFFF" : "#000000"}
      //         backgroundColor="transparent"
      //         underlayColor="transparent"
      //         onPress={() => {
      //           navigation.replace("AppWebView", {
      //             webviewURL: serverAppInfo.webviewURL,
      //             appName: appName,
      //             packageName: packageName,
      //             fromSettings: true,
      //           })
      //         }}
      //         style={{padding: 0, margin: 0}}
      //         iconStyle={{marginRight: 0}}
      //       />
      //     </View>
      //   ),
      // })
    }
  }, [serverAppInfo, packageName, appName])

  // Fetch TPA settings on mount or when packageName/status change.
  useEffect(() => {
    let isMounted = true
    let debounceTimeout: NodeJS.Timeout

    const loadCachedSettings = async () => {
      const cached = await loadSetting(SETTINGS_CACHE_KEY(packageName), null)
      if (cached && isMounted) {
        setServerAppInfo(cached.serverAppInfo)
        setSettingsState(cached.settingsState)
        setHasCachedSettings(!!(cached.serverAppInfo?.settings && cached.serverAppInfo.settings.length > 0))
        setSettingsLoading(false)
      } else {
        setHasCachedSettings(false)
        setSettingsLoading(true)
      }
    }

    // Load cached settings immediately
    loadCachedSettings()

    // Debounce fetch to avoid redundant calls
    debounceTimeout = setTimeout(() => {
      fetchUpdatedSettingsInfo()
    }, 150)

    return () => {
      isMounted = false
      clearTimeout(debounceTimeout)
    }
  }, [packageName])

  const fetchUpdatedSettingsInfo = async () => {
    // Only show skeleton if there are no cached settings
    if (!hasCachedSettings) setSettingsLoading(true)
    const startTime = Date.now() // For profiling
    try {
      const data = await backendServerComms.getTpaSettings(packageName)
      const elapsed = Date.now() - startTime
      console.log(`[PROFILE] getTpaSettings for ${packageName} took ${elapsed}ms`)
      // TODO: Profile backend and optimize if slow
      // If no data is returned from the server, create a minimal app info object
      if (!data) {
        setServerAppInfo({
          name: appInfo?.name || appName,
          description: appInfo?.description || "No description available.",
          settings: [],
          uninstallable: true,
        })
        setSettingsState({})
        setHasCachedSettings(false)
        setSettingsLoading(false)
        return
      }
      setServerAppInfo(data)
      // Initialize local state using the "selected" property.
      if (data.settings && Array.isArray(data.settings)) {
        const initialState: {[key: string]: any} = {}
        data.settings.forEach((setting: any) => {
          if (setting.type !== "group") {
            initialState[setting.key] = setting.selected
          }
        })
        setSettingsState(initialState)
        // Cache the settings
        saveSetting(SETTINGS_CACHE_KEY(packageName), {
          serverAppInfo: data,
          settingsState: initialState,
        })
        setHasCachedSettings(data.settings.length > 0)
      } else {
        setHasCachedSettings(false)
      }
      setSettingsLoading(false)
      // Auto-redirect to webview if needed
      if (data.webviewURL && fromWebView !== "true") {
        replace("/tpa/webview",
          {
            webviewURL: data.webviewURL,
            appName: appName,
            packageName: packageName,
          },
        )
      }
    } catch (err) {
      setSettingsLoading(false)
      setHasCachedSettings(false)
      console.error("Error fetching TPA settings:", err)
      setServerAppInfo({
        name: appInfo?.name || appName,
        description: appInfo?.description || "No description available.",
        settings: [],
        uninstallable: true,
      })
      setSettingsState({})
    }
  }

  // When a setting changes, update local state and send the full updated settings payload.
  const handleSettingChange = (key: string, value: any) => {
    console.log(`Changing ${key} to ${value}`)
    setSettingsState(prevState => ({
      ...prevState,
      [key]: value,
    }))

    // Build an array of settings to send.
    const updatedPayload = Object.keys(settingsState).map(settingKey => ({
      key: settingKey,
      value: settingKey === key ? value : settingsState[settingKey],
    }))

    backendServerComms
      .updateTpaSetting(packageName, {key, value})
      .then(data => {
        console.log("Server update response:", data)
      })
      .catch(error => {
        console.error("Error updating setting on server:", error)
      })
  }

  // Render each setting.
  const renderSetting = (setting: any, index: number) => {
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
          />
        )
      case "text":
        return (
          <TextSettingNoSave
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            onChangeText={text => handleSettingChange(setting.key, text)}
          />
        )
      case "text_no_save_button":
        return (
          <TextSettingNoSave
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            onChangeText={text => handleSettingChange(setting.key, text)}
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
          />
        )
      case "select":
        return (
          <SelectSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            options={setting.options}
            onValueChange={val => handleSettingChange(setting.key, val)}
          />
        )
      case "select_with_search":
        return (
          <SelectWithSearchSetting
            key={index}
            label={setting.label}
            value={settingsState[setting.key]}
            options={setting.options}
            onValueChange={val => handleSettingChange(setting.key, val)}
          />
        )
        return null
      case "multiselect":
        return (
          <MultiSelectSetting
            key={index}
            label={setting.label}
            values={settingsState[setting.key]}
            options={setting.options}
            onValueChange={vals => handleSettingChange(setting.key, vals)}
          />
        )
      case "titleValue":
        return <TitleValueSetting key={index} label={setting.label} value={setting.value} />
      default:
        return null
    }
  }

  if (!appInfo) {
    // Optionally, you could render a fallback error or nothing
    return null
  }

  return (
    <Screen preset="auto" safeAreaEdges={[]} style={{paddingHorizontal: theme.spacing.md}}>
      {isUninstalling && <LoadingOverlay message={`Uninstalling ${appInfo?.name || appName}...`} />}

      <View>
        <Header 
          title="" 
          leftIcon="caretLeft" 
          onLeftPress={() => router.back()}
          RightActionComponent={serverAppInfo?.webviewURL ? (
            <TouchableOpacity
              style={{ marginRight: 8 }}
              onPress={() => {
                router.replace({
                  pathname: "/tpa/webview",
                  params: {
                    webviewURL: serverAppInfo.webviewURL,
                    appName: appName as string,
                    packageName: packageName as string,
                    fromSettings: "true"
                  }
                })
              }}
            >
              <FontAwesome
                name="globe"
                size={22}
                color={theme.colors.text}
              />
            </TouchableOpacity>
          ) : undefined}
        />
        <Animated.View 
          style={{ 
            opacity: headerOpacity, 
            position: 'absolute',
            top: insets.top,
            left: 0,
            right: 0,
            height: 56,
            justifyContent: 'center',
            alignItems: 'center',
            pointerEvents: 'none',
          }}
        >
          <Text 
            text={appInfo?.name || appName}
            style={{
              fontSize: 17,
              fontWeight: '600',
              color: theme.colors.text,
            }}
            numberOfLines={1}
            ellipsizeMode="tail"
          />
        </Animated.View>
      </View>

      <Animated.ScrollView 
        style={{marginRight: -theme.spacing.md, paddingRight: theme.spacing.md}}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}>
        <View style={{gap: theme.spacing.lg}}>
          {/* Combined App Info and Action Section */}
          <View style={themed($topSection)}>
            <AppIcon app={appInfo} isForegroundApp={appInfo.is_foreground} style={themed($appIconLarge)} />
            
            <View style={themed($rightColumn)}>
              <View style={themed($textContainer)}>
                <Text style={[themed($appNameSmall)]}>{appInfo.name}</Text>
                <Text style={[themed($versionText)]}>{appInfo.version || "1.0.0"}</Text>
              </View>
              <View style={themed($buttonContainer)}>
                <PillButton 
                  text={appInfo.is_running ? "Stop" : "Start"}
                  onPress={handleStartStopApp}
                  variant="secondary"
                  buttonStyle={{paddingHorizontal: theme.spacing.lg, minWidth: 80}}
                />
              </View>
            </View>
          </View>

          <Divider variant="full" />

          {/* Description Section */}
          <View style={themed($descriptionSection)}>
            <Text style={themed($descriptionText)}>{appInfo.description || "No description available."}</Text>
          </View>

          <Divider variant="full" />

          {/* App Instructions Section */}
          {serverAppInfo?.instructions && (
            <View
              style={[
                themed($sectionContainer),
              ]}>
              <Text style={[themed($sectionTitle)]}>About this App</Text>
              <Text style={[themed($instructionsText)]}>{serverAppInfo.instructions}</Text>
            </View>
          )}

          {/* App Settings Section */}
          <View style={themed($settingsContainer)}>
            {settingsLoading && (!serverAppInfo?.settings || typeof serverAppInfo.settings === "undefined") ? (
              <SettingsSkeleton />
            ) : serverAppInfo?.settings && serverAppInfo.settings.length > 0 ? (
              serverAppInfo.settings.map((setting: any, index: number) =>
                renderSetting({...setting, uniqueKey: `${setting.key}-${index}`}, index),
              )
            ) : (
              <Text style={themed($noSettingsText)}>No settings available for this app</Text>
            )}
          </View>

          {/* Additional Information Section */}
          <View>
            <Text style={[
              themed($groupTitle), 
              {
                marginTop: theme.spacing.md,
                marginBottom: theme.spacing.xs,
                paddingHorizontal: theme.spacing.md,
                fontSize: 16,
                fontFamily: "Montserrat-Regular",
                color: theme.colors.textDim,
              }
            ]}>Other</Text>
            <SettingsGroup>
              <View style={{paddingVertical: theme.spacing.sm}}>
                <Text style={{fontSize: 15, color: theme.colors.text}}>Additional Information</Text>
              </View>
              <InfoRow 
                label="Company" 
                value={serverAppInfo?.company || "-"} 
                showDivider={false}
              />
              <InfoRow 
                label="Website" 
                value={serverAppInfo?.website || "-"} 
                showDivider={false}
              />
              <InfoRow 
                label="Contact" 
                value={serverAppInfo?.contact || "-"} 
                showDivider={false}
              />
              <InfoRow 
                label="App Type" 
                value={appInfo?.tpaType === "standard" ? "Standard" : appInfo?.tpaType === "background" ? "Background" : "-"} 
                showDivider={false}
              />
              <InfoRow 
                label="Package Name" 
                value={packageName} 
                showDivider={false}
              />
            </SettingsGroup>
          </View>

          {/* Uninstall Button at the bottom */}
          {serverAppInfo?.uninstallable && (
            <ActionButton
              label="Uninstall"
              variant="destructive"
              onPress={handleUninstallApp}
            />
          )}

          {/* Bottom safe area padding */}
          <View style={{height: Math.max(40, insets.bottom + 20)}} />
        </View>
      </Animated.ScrollView>
    </Screen>
  )
}

const $topSection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.lg,
  alignItems: "center",
})

const $rightColumn: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: 'space-between',
})

const $textContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.xxs,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignSelf: 'flex-start',
  marginTop: spacing.sm,
})

const $appIconLarge: ThemedStyle<ViewStyle> = () => ({
  width: 90,
  height: 90,
  borderRadius: 45, // Half of width/height for perfect circle
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
  paddingVertical: spacing.xs,
  paddingHorizontal: spacing.md,
})

const $appInfoHeader: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  padding: spacing.md,
  borderRadius: spacing.sm,
  borderWidth: 1,
  elevation: 2,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.1,
  shadowRadius: spacing.xxs,
})


const $descriptionContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  paddingTop: spacing.sm,
  borderTopWidth: 1,
  borderTopColor: colors.separator,
})

const $descriptionText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontFamily: "Montserrat-Regular",
  lineHeight: 22,
  color: colors.text,
})

const $appName: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 24,
  fontWeight: "bold",
  fontFamily: "Montserrat-Bold",
  marginBottom: spacing.xxs,
  color: colors.text,
})


const $sectionContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  borderRadius: spacing.sm,
  borderWidth: 1,
  padding: spacing.md,
  elevation: 2,
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.1,
  shadowRadius: spacing.xxs,
  backgroundColor: colors.background,
  borderColor: colors.border,
})

const $sectionTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 18,
  fontWeight: "bold",
  fontFamily: "Montserrat-Bold",
  marginBottom: spacing.sm,
  color: colors.text,
})

const $instructionsText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  lineHeight: 22,
  fontFamily: "Montserrat-Regular",
  color: colors.text,
})

const $settingsContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.md,
})

const $noSettingsText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontFamily: "Montserrat-Regular",
  fontStyle: "italic",
  textAlign: "center",
  padding: spacing.md,
  color: colors.textDim,
})

const $loadingContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  marginHorizontal: spacing.md + spacing.xxs, // 20px
})

const $groupTitle: ThemedStyle<TextStyle> = () => ({})

