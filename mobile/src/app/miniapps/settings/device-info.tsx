import {ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function DeviceInfoScreen() {
  const {goBack} = useNavigationStore.getState()
  const {theme} = useAppTheme()

  // Get all available device info from the glasses store
  const deviceModel = useGlassesStore((state) => state.deviceModel)
  const bluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const fwVersion = useGlassesStore((state) => state.fwVersion)
  const btMacAddress = useGlassesStore((state) => state.btMacAddress)
  const appVersion = useGlassesStore((state) => state.appVersion)
  const serialNumber = useGlassesStore((state) => state.serialNumber)
  const connectedWifi = useGlassesStore((state) => (state.wifi.state === "connected" ? state.wifi : null))
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Extract short bluetooth ID from full name (e.g., "MentraLive_664ebf" -> "664ebf")
  const bluetoothId = bluetoothName?.split("_").pop() || bluetoothName

  return (
    <Screen preset="fixed">
      <Header titleTx="deviceInfo:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="flex flex-col gap-6 pt-6">
          {/* Device Identity */}
          <Group title={translate("deviceInfo:deviceIdentity")}>
            <RouteButton label={translate("deviceInfo:model")} text={deviceModel || defaultWearable || "Unknown"} />
            {!!bluetoothId && <RouteButton label={translate("deviceInfo:deviceId")} text={bluetoothId} />}
            {!!serialNumber && <RouteButton label={translate("deviceInfo:serialNumber")} text={serialNumber} />}
            {!!btMacAddress && <RouteButton label={translate("deviceInfo:btMacAddress")} text={btMacAddress} />}
          </Group>

          {/* Software Version */}
          <Group title={translate("deviceInfo:softwareVersion")}>
            {!!buildNumber && <RouteButton label={translate("deviceInfo:buildNumber")} text={buildNumber} />}
            {!!fwVersion && <RouteButton label={translate("deviceInfo:firmwareVersion")} text={fwVersion} />}
            {!!appVersion && <RouteButton label={translate("deviceInfo:appVersion")} text={appVersion} />}
          </Group>

          {/* Network Info - only show if connected to WiFi */}
          <Group title={translate("deviceInfo:networkInfo")}>
            {connectedWifi && <RouteButton label={translate("deviceInfo:wifiNetwork")} text={connectedWifi.ssid} />}
            {connectedWifi?.localIp && (
              <RouteButton label={translate("deviceInfo:localIpAddress")} text={connectedWifi.localIp} />
            )}
          </Group>
        </View>
      </ScrollView>
    </Screen>
  )
}
