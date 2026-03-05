import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useEffect, useRef} from "react"
import {ScrollView, View} from "react-native"
import {useSharedValue} from "react-native-reanimated"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {ActiveForegroundApp} from "@/components/home/ActiveForegroundApp"
import {BackgroundAppsLink} from "@/components/home/BackgroundAppsLink"
import {CompactDeviceStatus} from "@/components/home/CompactDeviceStatus"
import {AppsGrid} from "@/components/home/AppsGrid"
import {IncompatibleApps} from "@/components/home/IncompatibleApps"
import {PairGlassesCard} from "@/components/home/PairGlassesCard"
import {Header, Screen} from "@/components/ignite"
import NonProdWarning from "@/components/home/NonProdWarning"
import {Group} from "@/components/ui"
import {useRefreshApplets} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useGlassesStore} from "@/stores/glasses"
import {useCoreStore} from "@/stores/core"
import WebsocketStatus from "@/components/error/WebsocketStatus"
import CoreStatusBar from "@/components/dev/CoreStatusBar"
import AppSwitcherButton from "@/components/home/AppSwitcherButtton"
import AppSwitcher from "@/components/home/AppSwitcher"
import {DeviceStatus} from "@/components/home/DeviceStatus"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

export default function Homepage() {
  const refreshApplets = useRefreshApplets()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)
  const [debugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const isSearching = useCoreStore((state) => state.searching)
  const hasAttemptedInitialConnect = useRef(false)
  const [appSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)
  const swipeProgress = useSharedValue(0)
  const insets = useSaferAreaInsets()

  useFocusEffect(
    useCallback(() => {
      refreshApplets()
    }, [refreshApplets]),
  )

  useEffect(() => {
    const attemptInitialConnect = async () => {
      if (hasAttemptedInitialConnect.current) {
        return
      }
      let attempted = await attemptReconnectToDefaultWearable()
      if (attempted) {
        hasAttemptedInitialConnect.current = true
      }
    }

    attemptInitialConnect()
  }, [glassesConnected, isSearching, defaultWearable])

  const renderContent = () => {
    if (!defaultWearable) {
      return (
        <>
          {debugCoreStatusBarEnabled && <CoreStatusBar />}
          <Group>
            <PairGlassesCard />
          </Group>
          <View className="flex-1" />
        </>
      )
    }

    return (
      <>
        {debugCoreStatusBarEnabled && <CoreStatusBar />}
        <Group>
          {!appSwitcherUi && <CompactDeviceStatus />}
          {appSwitcherUi && <DeviceStatus />}
          {!offlineMode && !appSwitcherUi && <BackgroundAppsLink />}
        </Group>
        <View className="h-2" />
        {!appSwitcherUi && <ActiveForegroundApp />}
        <AppsGrid />
      </>
    )
  }

  return (
    <Screen preset="fixed">
      {appSwitcherUi && <View style={{paddingTop: insets.top}} />}
      {!appSwitcherUi && (
        <Header
          leftTx="home:title"
          RightActionComponent={
            <View className="flex-row items-center flex-1 justify-end">
              <WebsocketStatus />
              <NonProdWarning />
              <View className="w-2" />
              <MentraLogoStandalone />
            </View>
          }
        />
      )}

      {/* {appSwitcherUi && (
        <View className="px-6 flex-row">
          <WebsocketStatus />
          <NonProdWarning />
        </View>
      )} */}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{flex: 1}}
        contentContainerStyle={{flexGrow: 1}}
        scrollEventThrottle={16}>
        <View className="h-4" />
        {renderContent()}
        <View className="h-4" />
        {!appSwitcherUi && <IncompatibleApps />}
        {/* spacer for scrolling to the bottom of the screen */}
        {/* {appSwitcherUi && <View className="h-25" />} */}
      </ScrollView>
      {appSwitcherUi && <AppSwitcherButton swipeProgress={swipeProgress} />}
      {appSwitcherUi && <AppSwitcher swipeProgress={swipeProgress} />}
    </Screen>
  )
}
