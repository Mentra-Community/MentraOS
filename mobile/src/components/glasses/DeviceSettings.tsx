import CoreModule from "core"
import {Platform, View, ViewStyle} from "react-native"

import OtaProgressSection from "@/components/glasses/OtaProgressSection"
import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {EmptyState} from "@/components/glasses/info/EmptyState"
import {ButtonSettings} from "@/components/glasses/settings/ButtonSettings"
import {Icon} from "@/components/ignite"
import BrightnessSetting from "@/components/settings/BrightnessSetting"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useCoreStatus} from "@/contexts/CoreStatusProvider"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"
import {useApplets} from "@/stores/applets"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"

export default function DeviceSettings() {
  const {theme, themed} = useAppTheme()
  const {status} = useCoreStatus()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
    SETTINGS.default_button_action_enabled.key,
  )
  const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS.default_button_action_app.key)
  const glassesConnected = useGlassesStore(state => state.connected)
  const glassesModelName = useGlassesStore(state => state.modelName)

  const {push, goBack} = useNavigationHistory()
  const applets = useApplets()
  const features: Capabilities = getModelCapabilities(defaultWearable)

  // Check if we have any advanced settings to show
  const hasMicrophoneSelector =
    glassesConnected &&
    defaultWearable &&
    features?.hasMicrophone &&
    (defaultWearable !== "Mentra Live" || (Platform.OS === "android" && glassesModelName !== "K900"))

  const wifiLocalIp = useGlassesStore(state => state.wifiSsid)
  const bluetoothName = useGlassesStore(state => state.bluetoothName)
  const buildNumber = useGlassesStore(state => state.buildNumber)

  const hasDeviceInfo = Boolean(bluetoothName || buildNumber || wifiLocalIp)

  const confirmForgetGlasses = () => {
    showAlert(
      translate("settings:forgetGlasses"),
      translate("settings:forgetGlassesConfirm"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {
          text: "Unpair",
          onPress: () => {
            CoreModule.forget()
            goBack()
          },
        },
      ],
      {
        cancelable: false,
      },
    )
  }

  const confirmDisconnectGlasses = () => {
    showAlert(
      translate("settings:disconnectGlassesTitle"),
      translate("settings:disconnectGlassesConfirm"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {
          text: "Disconnect",
          onPress: () => {
            CoreModule.disconnect()
          },
        },
      ],
      {
        cancelable: false,
      },
    )
  }

  // Check if no glasses are paired at all
  if (!defaultWearable) {
    return <EmptyState />
  }

  return (
    <View style={themed($container)}>
      {/* Screen settings for binocular glasses */}
      <Group
        title={translate("deviceSettings:display")}
        // subtitle={translate("settings:screenDescription")}
      >
        {defaultWearable && (features?.display?.count ?? 0 > 1) && (
          <RouteButton
            icon={<Icon name="locate" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:screenSettings")}
            // subtitle={translate("settings:screenDescription")}
            onPress={() => push("/settings/screen")}
          />
        )}
        {/* Only show dashboard settings if glasses have display capability */}
        {defaultWearable && features?.hasDisplay && (
          <RouteButton
            icon={<Icon name="layout-dashboard" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:dashboardSettings")}
            // subtitle={translate("settings:dashboardDescription")}
            onPress={() => push("/settings/dashboard")}
          />
        )}
        {/* Brightness Settings */}
        {features?.display?.adjustBrightness && glassesConnected && (
          <BrightnessSetting
            icon={<Icon name="brightness-half" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:autoBrightness")}
            autoBrightnessValue={autoBrightness}
            brightnessValue={brightness}
            onAutoBrightnessChange={setAutoBrightness}
            onBrightnessChange={() => {}}
            onBrightnessSet={setBrightness}
          />
        )}
      </Group>

      {/* Battery Status Section */}
      {glassesConnected && <BatteryStatus />}

      {/* Nex Developer Settings - Only show when connected to Mentra Nex */}
      {defaultWearable && defaultWearable.includes(DeviceTypes.NEX) && (
        <RouteButton
          // icon={}
          label="Nex Developer Settings"
          subtitle="Advanced developer tools and debugging features"
          onPress={() => push("/glasses/nex-developer-settings")}
        />
      )}
      {/* Mic selector has been moved to Advanced Settings section below */}

      {/* Camera Settings button moved to Gallery Settings page */}

      {/* Button Settings - Only show for glasses with configurable buttons */}
      {defaultWearable && features?.hasButton && (
        <ButtonSettings
          enabled={defaultButtonActionEnabled}
          selectedApp={defaultButtonActionApp}
          applets={applets}
          onEnabledChange={setDefaultButtonActionEnabled}
          onAppChange={setDefaultButtonActionApp}
        />
      )}

      {/* Only show WiFi settings if connected glasses support WiFi */}
      {defaultWearable && features?.hasWifi && (
        <RouteButton
          icon={<Icon name="wifi" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("settings:glassesWifiSettings")}
          onPress={() => {
            push("/pairing/glasseswifisetup", {deviceModel: defaultWearable || "Glasses"})
          }}
        />
      )}

      {/* Device info is rendered within the Advanced Settings section below */}

      {/* OTA Progress Section - Only show for Mentra Live glasses */}
      {defaultWearable && glassesConnected && defaultWearable.includes(DeviceTypes.LIVE) && (
        <OtaProgressSection otaProgress={status.ota_progress} />
      )}

      <Group title={translate("deviceSettings:general")}>
        {glassesConnected && defaultWearable !== DeviceTypes.SIMULATED && (
          <RouteButton
            icon={<Icon name="unlink" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:disconnectGlasses")}
            onPress={confirmDisconnectGlasses}
          />
        )}

        {defaultWearable && (
          <RouteButton
            icon={<Icon name="unplug" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:unpairGlasses")}
            onPress={confirmForgetGlasses}
          />
        )}
      </Group>

      {/* Advanced Settings Dropdown - Only show if there's content */}
      {/* {defaultWearable && hasAdvancedSettingsContent && (
        <AdvancedSettingsDropdown
          isOpen={showAdvancedSettings}
          onToggle={() => setShowAdvancedSettings(!showAdvancedSettings)}>
          {hasMicrophoneSelector && <MicrophoneSelector preferredMic={preferredMic} onMicChange={setMic} />}
          {glassesConnected && <DeviceInformation />}
        </AdvancedSettingsDropdown>
      )} */}

      <Group title={translate("deviceSettings:advancedSettings")}>
        {hasMicrophoneSelector && (
          <RouteButton
            icon={<Icon name="microphone" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:microphone")}
            onPress={() => push("/settings/microphone")}
          />
        )}
        {hasDeviceInfo && (
          <RouteButton
            icon={<Icon name="device-ipad" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:deviceInformation")}
            onPress={() => push("/settings/device-info")}
          />
        )}
      </Group>

      {/* this just gives the user a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s6,
})
