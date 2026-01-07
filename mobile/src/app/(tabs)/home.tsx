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
import CloudConnection from "@/components/misc/CloudConnection"
import NonProdWarning from "@/components/misc/NonProdWarning"
import {Group} from "@/components/ui"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useRefreshApplets} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function Homepage() {
  const {theme} = useAppTheme()
  const refreshApplets = useRefreshApplets()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)

  useFocusEffect(
    useCallback(() => {
      refreshApplets()
    }, [refreshApplets]),
  )

  return (
    <Screen preset="fixed">
      <Header
        leftTx="home:title"
        RightActionComponent={
          <View style={{flexDirection: "row", alignItems: "center"}}>
            <NonProdWarning />
            <MentraLogoStandalone />
          </View>
        }
      />

      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <Spacer height={theme.spacing.s4} />
        <CloudConnection />
        <Group>
          {!defaultWearable && <PairGlassesCard />}
          {defaultWearable && <CompactDeviceStatus />}
          {!offlineMode && <BackgroundAppsLink />}
        </Group>
        <Spacer height={theme.spacing.s2} />
        <ActiveForegroundApp />
        <Spacer height={theme.spacing.s2} />
        <ForegroundAppsGrid />
        <IncompatibleApps />
      </ScrollView>
    </Screen>
  )
}
