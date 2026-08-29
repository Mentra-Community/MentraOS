import {ScrollView, View} from "react-native"

import {DeviceTypes} from "@mentra/engine"
import {Header, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {showAlert} from "@/contexts/ModalContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {getAr99DisplayName} from "@/utils/getGlassesImage"

export default function DeviceInfoScreen() {
  const {goBack} = useNavigationStore.getState()
  const {theme} = useAppTheme()

  const deviceInfo = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange))
  const glassesStatus = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const connectedWifi = deviceInfo.wifi.state === "connected" ? deviceInfo.wifi : null
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [projectName] = useSetting<string>(SETTINGS.project_name.key)
  const displayModel = defaultWearable === DeviceTypes.AR99 ? getAr99DisplayName(projectName) : deviceInfo.model || defaultWearable || "Unknown"
  const isAr99Family = [defaultWearable, deviceInfo.model, deviceInfo.bluetoothName].some(
    (value) => typeof value === "string" && value.toUpperCase().includes(DeviceTypes.AR99),
  )
  const displayFirmwareVersion = deviceInfo.firmwareVersion

  // Extract short bluetooth ID from full name (e.g., "MentraLive_664ebf" -> "664ebf")
  const bluetoothId = deviceInfo.bluetoothName?.split("_").pop() || deviceInfo.bluetoothName

  const confirmFactoryReset = async () => {
    const result = await showAlert({
      title: translate("deviceInfo:factoryResetAlertTitle"),
      message: translate("deviceInfo:factoryResetAlertMessage"),
      buttons: [
        {text: translate("common:cancel"), style: "cancel"},
        {text: translate("common:confirm"), style: "destructive"},
      ],
      options: {allowDismiss: false},
    })

    if (result !== 1) {
      return
    }

    try {
      await BluetoothSdk.sendAr99FactoryReset()
    } catch (error) {
      console.error("AR99 factory reset failed:", error)
      await showAlert({
        title: translate("deviceInfo:factoryResetFailedTitle"),
        message: translate("deviceInfo:factoryResetFailedMessage"),
        buttons: [{text: translate("common:ok")}],
      })
    }
  }

  return (
    <Screen preset="fixed">
      <Header titleTx="deviceInfo:title" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="flex flex-col gap-6 pt-6">
          {/* Device Identity */}
          <Group title={translate("deviceInfo:deviceIdentity")}>
            <RouteButton
              label={translate("deviceInfo:model")}
              text={displayModel}
            />
            {!!bluetoothId && !isAr99Family && <RouteButton label={translate("deviceInfo:deviceId")} text={bluetoothId} />}
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
            {!!displayFirmwareVersion && (
              <RouteButton label={translate("deviceInfo:firmwareVersion")} text={displayFirmwareVersion} />
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

          {isAr99Family && (
            <RouteButton
              label={translate("deviceInfo:factoryReset")}
              onPress={glassesStatus.state === "connected" ? confirmFactoryReset : undefined}
              preset="destructive"
              disabled={glassesStatus.state !== "connected"}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}
