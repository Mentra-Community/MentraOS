import React, {useMemo, useState, useRef, useEffect} from "react"
import {View, ViewStyle, Animated, Easing} from "react-native"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import EmptyAppsView from "../home/EmptyAppsView"
import {colors, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {router} from "expo-router"
import TempActivateAppWindow from "./TempActivateAppWindow"
import {AppListItem} from "./AppListItem"
import Divider from "./Divider"
import {Spacer} from "./Spacer"
import Toast from "react-native-toast-message"
import {TruckIcon} from "assets/icons/component/TruckIcon"
import {translate} from "@/i18n"
import AppsHeader from "./AppsHeader"
import {loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"

export default function AppsActiveList({
  isSearchPage = false,
  searchQuery,
}: {
  isSearchPage?: boolean
  searchQuery?: string
}) {
  const {appStatus, refreshAppStatus, optimisticallyStopApp, clearPendingOperation} = useAppStatus()
  const backendComms = BackendServerComms.getInstance()
  const [isLoading, setIsLoading] = useState(false)
  const {themed, theme} = useAppTheme()
  const [hasEverActivatedApp, setHasEverActivatedApp] = useState(true)

  const runningApps = useMemo(() => {
    let apps = appStatus.filter(app => app.is_running)
    if (searchQuery) {
      apps = apps.filter(app => app.name.toLowerCase().includes(searchQuery.toLowerCase()))
    }
    return apps
  }, [appStatus, searchQuery])

  const opacities = useRef<Record<string, Animated.Value>>(
    Object.fromEntries(appStatus.map(app => [app.packageName, new Animated.Value(0)])),
  ).current

  const containerHeight = useRef(new Animated.Value(0)).current
  const previousCount = useRef(0)

  const emptyViewOpacity = useRef(new Animated.Value(0)).current

  // Check if user has ever activated an app
  useEffect(() => {
    const checkHasActivatedApp = async () => {
      const hasActivated = await loadSetting(SETTINGS_KEYS.HAS_EVER_ACTIVATED_APP, false)
      setHasEverActivatedApp(hasActivated)
    }
    checkHasActivatedApp()
  }, [])

  // Update hasEverActivatedApp when apps change
  useEffect(() => {
    const checkHasActivatedApp = async () => {
      const hasActivated = await loadSetting(SETTINGS_KEYS.HAS_EVER_ACTIVATED_APP, false)
      setHasEverActivatedApp(hasActivated)
    }
    // Re-check when app status changes (e.g., after activating first app)
    checkHasActivatedApp()
  }, [appStatus])

  useEffect(() => {
    appStatus.forEach(app => {
      if (!(app.packageName in opacities)) {
        opacities[app.packageName] = new Animated.Value(0)
      }

      if (app.is_running) {
        Animated.timing(opacities[app.packageName], {
          toValue: 1,
          duration: 300,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }).start()
      }
    })
  }, [appStatus])

  useEffect(() => {
    // Skip animation logic when on search page
    if (isSearchPage) return
    
    const newCount = runningApps.length
    if (newCount !== previousCount.current) {
      Animated.timing(containerHeight, {
        toValue: newCount * 88, // estimate item + spacing height
        duration: 300,
        useNativeDriver: false,
      }).start()
      if (newCount === 0) {
        Animated.timing(emptyViewOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }).start()
      } else if (previousCount.current === 0 && newCount > 0) {
        Animated.timing(emptyViewOpacity, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }).start()
      }
      previousCount.current = newCount
    }
    // special case when the app is first started with an empty list:
    if (newCount === 0 && previousCount.current === 0) {
      Animated.timing(emptyViewOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start()
    }
  }, [runningApps.length, isSearchPage])

  const stopApp = async (packageName: string) => {
    console.log("STOP APP")

    // Optimistically update UI first
    optimisticallyStopApp(packageName)

    setIsLoading(true)
    try {
      await backendComms.stopApp(packageName)
      // Clear the pending operation since it completed successfully
      clearPendingOperation(packageName)
      showToast()
    } catch (error) {
      // On error, refresh from the server to get the accurate state
      refreshAppStatus()
      console.error("Stop app error:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const openAppSettings = (app: any) => {
    router.push({
      pathname: "/tpa/settings",
      params: {
        packageName: app.packageName,
        appName: app.name,
      },
    })
  }

  function getAppsList() {
    if (runningApps.length === 0) {
      return null
    }

    return (
      <>
        {runningApps.map((app, index) => {
          const itemOpacity = opacities[app.packageName]
          return (
            <React.Fragment key={app.packageName}>
              <AppListItem
                app={app}
                is_foreground={app.tpaType == "standard"}
                isActive={true}
                onTogglePress={() => {
                  Animated.timing(itemOpacity, {
                    toValue: 0,
                    duration: 300,
                    useNativeDriver: true,
                  }).start()

                  setTimeout(() => {
                    const pkg = app.packageName
                    stopApp(pkg).then(() => {})
                  }, 300)
                }}
                onSettingsPress={() => openAppSettings(app)}
                opacity={itemOpacity}
                isDisabled={isLoading}
              />
              {index < runningApps.length - 1 && (
                <>
                  <Spacer height={8} />
                  <Divider variant="inset" />
                  <Spacer height={8} />
                </>
              )}
            </React.Fragment>
          )
        })}
      </>
    )
  }
  if (isSearchPage) {
    return (
      <View style={themed($appsContainer)}>
        <View style={themed($headerContainer)}></View>
        <View style={themed($contentContainer)}>
          {getAppsList()}
        </View>
      </View>
    )
  }

  return (
    <View style={themed($appsContainer)}>
      <View style={themed($headerContainer)}>
        {runningApps.length > 0 && <AppsHeader title="home:activeApps" showSearchIcon={true} />}
      </View>
      <Animated.View style={[themed($contentContainer), {minHeight: containerHeight}]}>
        {getAppsList()}

        {runningApps.length === 0 && (
          <Animated.View style={{opacity: emptyViewOpacity}}>
            {!hasEverActivatedApp ? (
              <TempActivateAppWindow />
            ) : (
              <EmptyAppsView
                statusMessageKey={"home:noActiveApps"}
                activeAppsMessageKey={"home:emptyActiveAppListInfo"}
              />
            )}
          </Animated.View>
        )}
      </Animated.View>
    </View>
  )
}

const $appsContainer: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "flex-start",
})

const $headerContainer: ThemedStyle<ViewStyle> = () => ({})

const $contentContainer: ThemedStyle<ViewStyle> = () => ({})

function showToast() {
  Toast.show({
    type: "baseToast",
    text1: translate("home:movedToInactive"),
    position: "bottom",
    props: {
      icon: <TruckIcon color={colors.icon} />,
    },
  })
}
