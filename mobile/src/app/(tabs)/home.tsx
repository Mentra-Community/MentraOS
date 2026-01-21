import {useFocusEffect} from "@react-navigation/native"
import {useCallback} from "react"
import {ScrollView, View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {ActiveForegroundApp} from "@/components/home/ActiveForegroundApp"
import {BackgroundAppsLink} from "@/components/home/BackgroundAppsLink"
import {CompactDeviceStatus} from "@/components/home/CompactDeviceStatus"
import {ForegroundAppsGrid} from "@/components/home/ForegroundAppsGrid"
import {IncompatibleApps} from "@/components/home/IncompatibleApps"
import {PairGlassesCard} from "@/components/home/PairGlassesCard"
import {Header, Screen} from "@/components/ignite"
import NonProdWarning from "@/components/home/NonProdWarning"
import {Group} from "@/components/ui"
import {useRefreshApplets} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import WebsocketStatus from "@/components/error/WebsocketStatus"

export default function Homepage() {
  const refreshApplets = useRefreshApplets()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)

  useFocusEffect(
    useCallback(() => {
      refreshApplets()
    }, [refreshApplets]),
  )

  const renderContent = () => {
    if (!defaultWearable) {
      return (
        <Group>
          <PairGlassesCard />
        </Group>
      )
    }

    return (
      <>
        <Group>
          <CompactDeviceStatus />
          {!offlineMode && <BackgroundAppsLink />}
        </Group>
        <View className="h-2" />
        <ActiveForegroundApp />
        <ForegroundAppsGrid />
      </>
    )
  }

  return (
    <Screen preset="fixed">
      <Header
        leftTx="home:title"
        RightActionComponent={
          <View className="flex-row items-center flex-1 justify-end">
            <WebsocketStatus />
            <NonProdWarning />
            <MentraLogoStandalone />
          </View>
        }
      />

      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <View className="h-4" />
        {renderContent()}
        <View className="h-4" />
        <IncompatibleApps />
      </ScrollView>
    </Screen>
  )
}
