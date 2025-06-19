// YourAppsList.tsx
import React, {useCallback, useEffect, useRef, useState} from "react"
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Platform,
  ViewStyle,
  ActivityIndicator,
  Easing,
} from "react-native"
import {Text} from "@/components/ignite"
import MessageModal from "./MessageModal"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import {loadSetting, saveSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {useFocusEffect, useNavigation} from "@react-navigation/native"
import AppIcon from "./AppIcon"
import {NavigationProps} from "./types"
import {AppInterface, TPAPermission, useAppStatus} from "@/contexts/AppStatusProvider"
import {requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {checkFeaturePermissions} from "@/utils/PermissionsUtils"
import {PermissionFeatures} from "@/utils/PermissionsUtils"
import showAlert from "@/utils/AlertUtils"
import {PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import ChevronRight from "assets/icons/component/ChevronRight"
import {translate} from "@/i18n"
import {useAppTheme} from "@/utils/useAppTheme"
import {router} from "expo-router"
import EmptyAppsView from "../home/EmptyAppsView"
import {AppListItem} from "./AppListItem"
import {Spacer} from "./Spacer"
import Divider from "./Divider"
import {spacing, ThemedStyle} from "@/theme"
import {TreeIcon} from "assets/icons/component/TreeIcon"
import AppsHeader from "./AppsHeader"
import {
  checkAndRequestNotificationAccessSpecialPermission,
  checkNotificationAccessSpecialPermission,
} from "@/utils/NotificationServiceUtils"
import {AppListStoreLink} from "./AppListStoreLink"

export default function InactiveAppList({
  isSearchPage = false,
  searchQuery,
  liveCaptionsRef,
}: {
  isSearchPage?: boolean
  searchQuery?: string
  liveCaptionsRef?: React.RefObject<any>
}) {
  const {
    appStatus,
    refreshAppStatus,
    optimisticallyStartApp,
    optimisticallyStopApp,
    clearPendingOperation,
    isSensingEnabled,
  } = useAppStatus()
  const {status} = useStatus()
  const [onboardingModalVisible, setOnboardingModalVisible] = useState(false)
  const [onboardingCompleted, setOnboardingCompleted] = useState(true)
  const [inLiveCaptionsPhase, setInLiveCaptionsPhase] = useState(false)
  const [showSettingsHint, setShowSettingsHint] = useState(false)
  const [showOnboardingTip, setShowOnboardingTip] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const {themed, theme} = useAppTheme()

  // Static values instead of animations
  const bounceAnim = React.useRef(new Animated.Value(0)).current
  const pulseAnim = React.useRef(new Animated.Value(0)).current

  const [containerWidth, setContainerWidth] = React.useState(0)

  // Reference for the Live Captions list item (use provided ref or create new one)
  const internalLiveCaptionsRef = useRef<any>(null)
  const actualLiveCaptionsRef = liveCaptionsRef || internalLiveCaptionsRef

  // Constants for grid item sizing
  const GRID_MARGIN = 6 // Total horizontal margin per item (left + right)
  const numColumns = 4 // Desired number of columns

  // Calculate the item width based on container width and margins
  const itemWidth = containerWidth > 0 ? (containerWidth - GRID_MARGIN * numColumns) / numColumns : 0

  const textColor = theme.isDark ? "#FFFFFF" : "#000000"

  const backendComms = BackendServerComms.getInstance()

  // console.log('%%% appStatus', appStatus);

  // Check onboarding status whenever the screen comes into focus
  useFocusEffect(
    React.useCallback(() => {
      const checkOnboardingStatus = async () => {
        const completed = await loadSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true)
        setOnboardingCompleted(completed)

        if (!completed) {
          setOnboardingModalVisible(true)
          setShowSettingsHint(false) // Hide settings hint during onboarding
          setShowOnboardingTip(true)
        } else {
          setShowOnboardingTip(false)

          // If onboarding is completed, check how many times settings have been accessed
          const settingsAccessCount = await loadSetting(SETTINGS_KEYS.SETTINGS_ACCESS_COUNT, 0)
          // Only show hint if they've accessed settings less than 1 times
          setShowSettingsHint(settingsAccessCount < 1)
        }
      }

      checkOnboardingStatus()
    }, []),
  )

  // Check if onboarding is completed on initial load
  useEffect(() => {
    const checkOnboardingStatus = async () => {
      const completed = await loadSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true)
      setOnboardingCompleted(completed)
      setShowOnboardingTip(!completed)
    }

    checkOnboardingStatus()
  }, [])

  // Set static values instead of animations
  useEffect(() => {
    if (showOnboardingTip) {
      // Set static values instead of animating
      bounceAnim.setValue(0)
      pulseAnim.setValue(0.5)
    } else {
      bounceAnim.setValue(0)
      pulseAnim.setValue(0)
    }
  }, [showOnboardingTip])

  const completeOnboarding = () => {
    saveSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true)
    setOnboardingCompleted(true)
    setShowOnboardingTip(false)
    setInLiveCaptionsPhase(false) // Reset any live captions phase state

    // Make sure to post an update to ensure all components re-render
    // This is important to immediately hide any UI elements that depend on these states
    setTimeout(() => {
      // Force a re-render by setting state again
      setShowOnboardingTip(false)
      setShowSettingsHint(true)
    }, 100)
  }

  const checkPermissions = async (app: AppInterface) => {
    let permissions = app.permissions || []
    const neededPermissions: string[] = []

    if (permissions.length == 1 && permissions[0].type == "ALL") {
      permissions = [
        {type: "MICROPHONE", required: true},
        {type: "CALENDAR", required: true},
        {type: "POST_NOTIFICATIONS", required: true},
        {type: "READ_NOTIFICATIONS", required: true},
        {type: "LOCATION", required: true},
      ] as TPAPermission[]
    }

    if (app.packageName == "cloud.mentraos.notify") {
      permissions.push({type: "READ_NOTIFICATIONS", required: true, description: "Read notifications"})
    }

    for (const permission of permissions) {
      if (!(permission["required"] ?? true)) {
        continue
      }
      switch (permission.type) {
        case "MICROPHONE":
          const hasMicrophone = await checkFeaturePermissions(PermissionFeatures.MICROPHONE)
          if (!hasMicrophone) {
            neededPermissions.push(PermissionFeatures.MICROPHONE)
          }
          break
        case "CAMERA":
          const hasCamera = await checkFeaturePermissions(PermissionFeatures.CAMERA)
          if (!hasCamera) {
            neededPermissions.push(PermissionFeatures.CAMERA)
          }
          break
        case "CALENDAR":
          const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
          if (!hasCalendar) {
            neededPermissions.push(PermissionFeatures.CALENDAR)
          }
          break
        case "LOCATION":
          const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
          if (!hasLocation) {
            neededPermissions.push(PermissionFeatures.LOCATION)
          }
          break
        case "POST_NOTIFICATIONS":
          const hasNotificationPermission = await checkFeaturePermissions(PermissionFeatures.POST_NOTIFICATIONS)
          if (!hasNotificationPermission) {
            neededPermissions.push(PermissionFeatures.POST_NOTIFICATIONS)
          }
          break
        case "READ_NOTIFICATIONS":
          if (Platform.OS == "ios") {
            break
          }
          const hasNotificationAccess = await checkNotificationAccessSpecialPermission()
          if (!hasNotificationAccess) {
            neededPermissions.push(PermissionFeatures.READ_NOTIFICATIONS)
          }
          break
      }
    }

    return neededPermissions
  }

  const requestPermissions = async (permissions: string[]) => {
    for (const permission of permissions) {
      await requestFeaturePermissions(permission)
    }

    if (permissions.includes(PermissionFeatures.READ_NOTIFICATIONS) && Platform.OS === "android") {
      await checkAndRequestNotificationAccessSpecialPermission()
    }
  }

  function checkIsForegroundAppStart(packageName: string, isForeground: boolean): Promise<boolean> {
    if (!isForeground) {
      return Promise.resolve(true)
    }

    const runningStndAppList = getRunningStandardApps(packageName)
    if (runningStndAppList.length === 0) {
      return Promise.resolve(true)
    }

    return new Promise(resolve => {
      showAlert(
        translate("home:thereCanOnlyBeOne"),
        translate("home:thereCanOnlyBeOneMessage"),
        [
          {
            text: translate("common:cancel"),
            onPress: () => resolve(false),
            style: "cancel",
          },
          {
            text: translate("common:continue"),
            onPress: () => resolve(true),
          },
        ],
        {icon: <TreeIcon size={24} />},
      )
    })
  }
  const startApp = async (packageName: string) => {
    if (!onboardingCompleted) {
      if (packageName !== "com.mentra.livecaptions" && packageName !== "cloud.mentraos.live-captions") {
        showAlert(
          translate("home:completeOnboardingTitle"),
          translate("home:completeOnboardingMessage"),
          [{text: translate("common:ok")}],
          {
            iconName: "information-outline",
          },
        )
        return
      } else {
        completeOnboarding()
      }
    }

    // Find the app we're trying to start
    const appToStart = appStatus.find(app => app.packageName === packageName)
    if (!appToStart) {
      console.error("App not found:", packageName)
      return
    }

    // check perms:
    const neededPermissions = await checkPermissions(appToStart)
    if (neededPermissions.length > 0) {
      await showAlert(
        neededPermissions.length > 1
          ? translate("home:permissionsRequiredTitle")
          : translate("home:permissionRequiredTitle"),
        translate("home:permissionMessage", {
          permissions: neededPermissions.map(perm => PERMISSION_CONFIG[perm]?.name || perm).join(", "),
        }),
        [
          {
            text: translate("common:cancel"),
            onPress: () => {},
            style: "cancel",
          },
          {
            text: translate("common:next"),
            onPress: async () => {
              await requestPermissions(neededPermissions)
              startApp(packageName)
            },
          },
        ],
        {
          iconName: "information-outline",
        },
      )
      return
    }

    // Check if glasses are connected and this is the first app being activated
    const glassesConnected = status.glasses_info?.model_name != null
    const activeApps = appStatus.filter(app => app.is_running)

    if (!glassesConnected && activeApps.length === 0) {
      // Show alert for first app activation when glasses aren't connected
      const shouldContinue = await new Promise<boolean>(resolve => {
        showAlert(translate("home:glassesNotConnected"), translate("home:appWillRunWhenConnected"), [
          {
            text: translate("common:cancel"),
            style: "cancel",
            onPress: () => resolve(false),
          },
          {
            text: translate("common:ok"),
            onPress: () => resolve(true),
          },
        ])
      })

      if (!shouldContinue) {
        return
      }
    }

    // Find the opacity value for this app
    const itemOpacity = opacities[packageName]

    // Animate the app disappearing
    if (itemOpacity) {
      Animated.timing(itemOpacity, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start()
    }

    // Wait a bit for animation to complete
    await new Promise(resolve => setTimeout(resolve, 300))

    // Only update UI optimistically after user confirms and animation completes
    optimisticallyStartApp(packageName)

    // Check if it's a standard app
    if (appToStart?.tpaType === "standard") {
      console.log("% appToStart", appToStart)
      // Find any running standard apps
      const runningStandardApps = getRunningStandardApps(packageName)

      console.log("%%% runningStandardApps", runningStandardApps)

      // If there's any running standard app, stop it first
      for (const runningApp of runningStandardApps) {
        // Optimistically update UI
        optimisticallyStopApp(runningApp.packageName)

        try {
          console.log("%%% stopping app", runningApp.packageName)
          await backendComms.stopApp(runningApp.packageName)
          clearPendingOperation(runningApp.packageName)
        } catch (error) {
          console.error("stop app error:", error)
          refreshAppStatus()
        }
      }
    }

    // Start the operation in the background
    setIsLoading(true)
    try {
      console.log("%%% starting app", packageName)
      await backendComms.startApp(packageName)
      // Clear the pending operation since it completed successfully
      clearPendingOperation(packageName)

      // Mark that the user has ever activated an app
      await saveSetting(SETTINGS_KEYS.HAS_EVER_ACTIVATED_APP, true)

      if (!onboardingCompleted && packageName === "com.mentra.livecaptions") {
        // If this is the Live Captions app, make sure we've hidden the tip
        setShowOnboardingTip(false)

        setTimeout(() => {
          showAlert(
            translate("home:tryLiveCaptionsTitle"),
            translate("home:tryLiveCaptionsMessage"),
            [{text: translate("common:ok")}],
            {
              iconName: "microphone",
            },
          )
        }, 500)
      }
    } catch (error) {
      // Revert the app state when there's an error starting the app
      console.error("start app error:", error)

      // Clear the pending operation for this app
      clearPendingOperation(packageName)
      // Refresh the app status to move the app back to inactive
      refreshAppStatus()
    } finally {
      setIsLoading(false)
    }
  }

  const getRunningStandardApps = (packageName: string) => {
    return appStatus.filter(app => app.is_running && app.tpaType === "standard" && app.packageName !== packageName)
  }
  const openAppSettings = (app: any) => {
    console.log("%%% opening app settings", app)
    router.push({
      pathname: "/tpa/settings",
      params: {
        packageName: app.packageName,
        appName: app.name,
      },
    })
  }

  // Filter out duplicate apps and running apps
  let availableApps = appStatus.filter(app => {
    if (app.is_running) {
      return false
    }
    // Check if this is the first occurrence of this package name
    const firstIndex = appStatus.findIndex(a => a.packageName === app.packageName)
    return firstIndex === appStatus.indexOf(app)
  })

  // remove the notify app on iOS
  if (Platform.OS === "ios") {
    availableApps = availableApps.filter(app => app.packageName !== "cloud.mentraos.notify" && app.name !== "Notify")
  }
  
  // Sort apps: during onboarding, put Live Captions first, otherwise alphabetical
  if (!onboardingCompleted) {
    availableApps.sort((a, b) => {
      // Check if either app is Live Captions
      const aIsLiveCaptions = a.packageName === "com.mentra.livecaptions" || 
                              a.packageName === "cloud.mentraos.live-captions"
      const bIsLiveCaptions = b.packageName === "com.mentra.livecaptions" || 
                              b.packageName === "cloud.mentraos.live-captions"
      
      // If a is Live Captions, it should come first
      if (aIsLiveCaptions && !bIsLiveCaptions) return -1
      // If b is Live Captions, it should come first
      if (!aIsLiveCaptions && bIsLiveCaptions) return 1
      // Otherwise sort alphabetically
      return a.name.localeCompare(b.name)
    })
  } else {
    // Normal alphabetical sort when onboarding is completed
    availableApps.sort((a, b) => a.name.localeCompare(b.name))
  }

  if (searchQuery) {
    availableApps = availableApps.filter(app => app.name.toLowerCase().includes(searchQuery.toLowerCase()))
  }

  // Create a ref for all app opacities, keyed by packageName
  const opacities = useRef<Record<string, Animated.Value>>(
    Object.fromEntries(appStatus.map(app => [app.packageName, new Animated.Value(0)])),
  ).current

  // Animate all availableApps' opacities to 1 on mount or change
  useEffect(() => {
    availableApps.forEach(app => {
      Animated.timing(opacities[app.packageName], {
        toValue: 1,
        duration: 300,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start()
    })
  }, [availableApps])

  return (
    <View>
      {!isSearchPage && (
        <AppsHeader title="home:inactiveApps" showSearchIcon={appStatus.filter(app => app.is_running).length === 0} />
      )}

      {availableApps.map((app, index) => {
        // Check if this is the LiveCaptions app
        const isLiveCaptions =
          app.packageName === "com.mentra.livecaptions" || app.packageName === "cloud.mentraos.live-captions"

        // Only set ref for LiveCaptions app
        const ref = isLiveCaptions ? actualLiveCaptionsRef : null

        // Get the shared opacity Animated.Value for this app
        const itemOpacity = opacities[app.packageName]

        return (
          <React.Fragment key={app.packageName}>
            <AppListItem
              app={app}
              is_foreground={app.tpaType == "standard"}
              isActive={false}
              onTogglePress={async () => {
                const res = await checkIsForegroundAppStart(app.packageName, app.tpaType == "standard")
                if (res) {
                  // Don't animate here - let startApp handle all UI updates
                  startApp(app.packageName)
                }
              }}
              onSettingsPress={() => openAppSettings(app)}
              refProp={ref}
              opacity={itemOpacity}
            />
            {index < availableApps.length - 1 && (
              <>
                <Spacer height={8} />
                <Divider variant="inset" />
                <Spacer height={8} />
              </>
            )}
          </React.Fragment>
        )
      })}

      {/* Add "Get More Apps" link at the bottom */}
      {availableApps.length > 0 && (
        <>
          <Spacer height={8} />
          <Divider variant="inset" />
          <Spacer height={8} />
          <AppListStoreLink />
        </>
      )}

      {/* Add bottom padding for better scrolling experience */}
      <Spacer height={40} />
    </View>
  )
}

const $loadingContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  marginTop: 50,
})

const styles = StyleSheet.create({
  // appsContainer: {
  //   marginTop: -8,
  //   marginBottom: 0,
  //   width: "100%",
  //   paddingHorizontal: 0,
  //   paddingVertical: 10,
  // },
  // titleContainer: {
  //   width: "100%",
  //   flexDirection: "row",
  //   alignItems: "center",
  //   justifyContent: "space-between",
  //   marginLeft: 0,
  //   paddingLeft: 0,
  // },
  // gridContainer: {
  //   flexDirection: "row",
  //   flexWrap: "wrap",
  //   justifyContent: "flex-start",
  // },
  // listContainer: {
  //   gap: 16,
  // },
  // appContent: {
  //   flexDirection: "row",
  //   alignItems: "center",
  //   minHeight: 40, // Match RunningAppsList minHeight
  // },
  // itemContainer: {
  //   alignItems: "center",
  //   justifyContent: "center",
  // },
  // emptyContainer: {
  //   alignItems: "center",
  //   justifyContent: "center",
  // },
  // tipButton: {
  //   flexDirection: "row",
  //   alignItems: "center",
  //   paddingHorizontal: 10,
  //   paddingVertical: 5,
  //   borderRadius: 15,
  // },
  // tipText: {
  //   marginLeft: 5,
  //   fontSize: 14,
  // },
  // appTextContainer: {
  //   flex: 1,
  //   marginLeft: 8,
  //   justifyContent: "center",
  // },
  // settingsButton: {
  //   padding: 50,
  //   margin: -46,
  // },
  // appIconStyle: {
  //   width: 50, // Match RunningAppsList icon size
  //   height: 50, // Match RunningAppsList icon size
  // },
  // settingsHintContainer: {
  //   padding: 12,
  //   borderRadius: 8,
  //   borderWidth: 1,
  //   marginBottom: 12,
  // },
  // hintContent: {
  //   flexDirection: "row",
  //   alignItems: "center",
  // },
  // hintText: {
  //   marginLeft: 10,
  //   fontSize: 14,
  //   fontWeight: "500",
  // },
  // sensingWarningContainer: {
  //   flexDirection: "row",
  //   alignItems: "center",
  //   justifyContent: "space-between",
  //   padding: 12,
  //   borderRadius: 8,
  //   borderWidth: 1,
  //   marginBottom: 12,
  // },
  // warningContent: {
  //   flexDirection: "row",
  //   alignItems: "center",
  //   flex: 1,
  // },
  // warningText: {
  //   marginLeft: 10,
  //   fontSize: 14,
  //   fontWeight: "500",
  //   color: "#E65100",
  //   flex: 1,
  // },
  // settingsButtonText: {
  //   color: "#FFFFFF",
  //   fontSize: 13,
  //   fontWeight: "bold",
  // },
  // settingsButtonBlue: {
  //   backgroundColor: "#007AFF",
  //   borderRadius: 5,
  //   paddingVertical: 5,
  //   paddingHorizontal: 10,
  //   margin: 0,
  // },
  // settingsButtonTextBlue: {
  //   color: "#007AFF",
  //   fontSize: 14,
  //   fontWeight: "bold",
  // },
  // scrollViewContent: {
  //   paddingBottom: Platform.OS === "ios" ? 24 : 38, // Account for nav bar height + iOS home indicator
  // },
  // appIcon: {
  //   width: 32,
  //   height: 32,
  // },
  // toggle: {
  //   width: 36,
  //   height: 20,
  // },
  // toggleBarIcon: {
  //   height: "80%",
  //   width: "94.44%",
  //   top: "15%",
  //   right: "5.56%",
  //   bottom: "15%",
  //   left: "0%",
  //   borderRadius: 8,
  //   maxHeight: "100%",
  // },
  // toggleCircleIcon: {
  //   width: "55.56%",
  //   top: 0,
  //   right: "47.22%",
  //   left: "-2.78%",
  //   borderRadius: 12,
  //   height: 20,
  // },
  // toggleIconLayout: {
  //   maxWidth: "100%",
  //   position: "absolute",
  //   overflow: "hidden",
  // },
  // everythingFlexBox: {
  //   flexDirection: "row",
  //   alignItems: "center",
  // },
  // everything: {
  //   justifyContent: "space-between",
  //   gap: 0,
  //   alignSelf: "stretch",
  // },
  // toggleParent: {
  //   gap: 12,
  // },
  // appDescription: {
  //   gap: 17,
  //   justifyContent: "center",
  // },
  // appNameWrapper: {
  //   justifyContent: "center",
  // },
  // appName: {
  //   fontSize: 15,
  //   letterSpacing: 0.6,
  //   lineHeight: 20,
  //   fontFamily: "SF Pro Rounded",
  //   color: "#ced2ed",
  //   textAlign: "left",
  //   overflow: "hidden",
  // },
})
