import {ScrollView, View} from "react-native"

import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/island"
import {toolkit} from "@mentra/island"

export default function DeviceInfoScreen() {
  const {goBack} = useNavigationStore.getState()
  const {theme} = useAppTheme()

  const deviceInfo = useToolkitSnapshot(toolkit.glasses.info, (onChange) => toolkit.glasses.onInfo(onChange))
  const connectedWifi = deviceInfo.wifi.state === "connected" ? deviceInfo.wifi : null
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Extract short bluetooth ID from full name (e.g., "MentraLive_664ebf" -> "664ebf")
  const bluetoothId = deviceInfo.bluetoothName?.split("_").pop() || deviceInfo.bluetoothName

  return (
    <Screen preset="fixed">
      <Header titleTx="deviceInfo:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="flex flex-col gap-6 pt-6">
          {/* Device Identity */}
          <Group title={translate("deviceInfo:deviceIdentity")}>
            <RouteButton
              label={translate("deviceInfo:model")}
              text={deviceInfo.model || defaultWearable || "Unknown"}
            />
            {!!bluetoothId && <RouteButton label={translate("deviceInfo:deviceId")} text={bluetoothId} />}
            {!!deviceInfo.serialNumber && (
              <RouteButton label={translate("deviceInfo:serialNumber")} text={deviceInfo.serialNumber} />
            )}
            {!!deviceInfo.btMac && (
              <RouteButton label={translate("deviceInfo:bluetoothMacAddress")} text={deviceInfo.btMac} />
            )}
          </Group>

          {/* Software Version */}
          <Group title={translate("deviceInfo:softwareVersion")}>
            {!!deviceInfo.buildNumber && (
              <RouteButton label={translate("deviceInfo:buildNumber")} text={deviceInfo.buildNumber} />
            )}
            {!!deviceInfo.firmwareVersion && (
              <RouteButton label={translate("deviceInfo:firmwareVersion")} text={deviceInfo.firmwareVersion} />
            )}
            {!!deviceInfo.appVersion && (
              <RouteButton label={translate("deviceInfo:appVersion")} text={deviceInfo.appVersion} />
            )}
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
