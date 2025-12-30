import {ScrollView} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import DeviceSettings from "@/components/glasses/DeviceSettings"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Header, Screen} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function Glasses() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {goBack} = useNavigationHistory()
  const glassesConnected = useGlassesStore(state => state.connected)

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase())
  let pageTitle

  if (defaultWearable) {
    pageTitle = formatGlassesTitle(defaultWearable)
  } else {
    pageTitle = translate("glasses:title")
  }

  return (
    <Screen preset="fixed">
      <Header title={pageTitle} leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        {/* <CloudConnection /> */}
        {/* {glassesConnected && features?.hasDisplay && <ConnectedSimulatedGlassesInfo />} */}
        {/* {glassesConnected && features?.hasDisplay && <ConnectedGlasses showTitle={false} />} */}
        {/* <Spacer height={theme.spacing.s6} /> */}
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
