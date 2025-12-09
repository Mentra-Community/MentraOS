import {View} from "react-native"

import {ActiveForegroundApp} from "@/components/home/ActiveForegroundApp"
import {BackgroundAppsLink} from "@/components/home/BackgroundAppsLink"
import {CompactDeviceStatus} from "@/components/home/CompactDeviceStatus"
import {ForegroundAppsGrid} from "@/components/home/ForegroundAppsGrid"
import {IncompatibleApps} from "@/components/home/IncompatibleApps"
import {PairGlassesCard} from "@/components/home/PairGlassesCard"
import {Group} from "@/components/ui/Group"
import {Spacer} from "@/components/ui/Spacer"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useAppTheme} from "@/utils/useAppTheme"

export const HomeContainer: React.FC = () => {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)

  return (
    <View>
      {/* <Spacer height={theme.spacing.s6} /> */}
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
      {/* <Spacer height={theme.spacing.s16} /> */}
      {/* <Spacer height={theme.spacing.s16} /> */}
      {/* <Spacer height={theme.spacing.s16} /> */}
    </View>
  )
}
