import {ScrollView} from "react-native"
import {Image} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import DeviceSettings from "@/components/glasses/DeviceSettings"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Header, Screen} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"

export default function Glasses() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {goBack} = useNavigationHistory()
  const glassesConnected = useGlassesStore((state) => state.connected)

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  let pageSubtitle
  let glassesComponent

  if (defaultWearable) {
    pageSubtitle = formatGlassesTitle(defaultWearable)
    glassesComponent = (
      <Image source={getGlassesImage(defaultWearable)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
    )
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("deviceSettings:title")}
        subtitle={pageSubtitle}
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        RightActionComponent={glassesComponent}
      />
      <ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        {!glassesConnected && <Spacer height={theme.spacing.s6} />}
        {!glassesConnected && <ConnectDeviceButton />}
        {/* Show helper text if glasses are paired but not connected */}
        {!glassesConnected && defaultWearable && <NotConnectedInfo />}
        <Spacer height={theme.spacing.s6} />
        <DeviceSettings />
      </ScrollView>
    </Screen>
  )
}
