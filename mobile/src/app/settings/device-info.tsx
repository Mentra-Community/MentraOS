import {ScrollView} from "react-native"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function DeviceInfoScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()

  // Get all available device info from the glasses store
  const modelName = useGlassesStore(state => state.modelName)
  const bluetoothName = useGlassesStore(state => state.bluetoothName)
  const buildNumber = useGlassesStore(state => state.buildNumber)
  const fwVersion = useGlassesStore(state => state.fwVersion)
  const appVersion = useGlassesStore(state => state.appVersion)
  const serialNumber = useGlassesStore(state => state.serialNumber)
  const wifiSsid = useGlassesStore(state => state.wifiSsid)
  const wifiLocalIp = useGlassesStore(state => state.wifiLocalIp)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Extract short bluetooth ID from full name (e.g., "MentraLive_664ebf" -> "664ebf")
  const bluetoothId = bluetoothName?.split("_").pop() || bluetoothName

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header titleTx="deviceInfo:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{flex: 1, gap: theme.spacing.s6, marginTop: theme.spacing.s6}}>
        {/* Device Identity */}
        <Group title={translate("deviceInfo:deviceIdentity")}>
          <RouteButton label={translate("deviceInfo:model")} text={modelName || defaultWearable || "Unknown"} />
          {!!bluetoothId && <RouteButton label={translate("deviceInfo:deviceId")} text={bluetoothId} />}
          {!!serialNumber && <RouteButton label={translate("deviceInfo:serialNumber")} text={serialNumber} />}
        </Group>

        {/* Software Version */}
        <Group title={translate("deviceInfo:softwareVersion")}>
          {!!buildNumber && <RouteButton label={translate("deviceInfo:buildNumber")} text={buildNumber} />}
          {!!fwVersion && <RouteButton label={translate("deviceInfo:firmwareVersion")} text={fwVersion} />}
          {!!appVersion && <RouteButton label={translate("deviceInfo:appVersion")} text={appVersion} />}
        </Group>

        {/* Network Info - only show if connected to WiFi */}
        <Group title={translate("deviceInfo:networkInfo")}>
          {!!wifiSsid && <RouteButton label={translate("deviceInfo:wifiNetwork")} text={wifiSsid} />}
          {!!wifiLocalIp && <RouteButton label={translate("deviceInfo:localIpAddress")} text={wifiLocalIp} />}
        </Group>
      </ScrollView>
    </Screen>
  )
}
