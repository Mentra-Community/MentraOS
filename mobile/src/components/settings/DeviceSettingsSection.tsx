import {Image, View} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Icon, Text} from "@/components/ignite"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n/translate"
import {selectGlassesConnected, useGlassesStore} from "@/stores/glasses"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"

import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {useApps} from "@mentra/island"

import OtaProgressSection from "@/components/glasses/OtaProgressSection"
import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {ButtonSettings} from "@/components/glasses/settings/ButtonSettings"
import BrightnessSetting from "@/components/settings/BrightnessSetting"

const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())

/**
 * Returns whether device-information rows (bluetooth name, build number, local
 * IP) are available. Lives here so the "Device Information" row can be hosted by
 * whatever page embeds the device settings (e.g. the flattened main settings
 * page) while keeping the glasses-store wiring in one place.
 */
export function useHasDeviceInfo(): boolean {
  const wifiLocalIp = useGlassesStore((state) => (state.wifi.state === "connected" ? state.wifi.localIp : undefined))
  const bluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  return Boolean(bluetoothName || buildNumber || wifiLocalIp)
}

interface DeviceSettingsSectionProps {
  /**
   * Show the inline device identity header (model name + glasses image). The
   * standalone glasses page already renders this in its screen Header, so it
   * opts out; the flattened main settings page shows it inline.
   */
  showDeviceHeader?: boolean
  /**
   * Render the device "Advanced Settings" group (Device Information +
   * Microphone). The flattened main settings page hosts these in its own
   * page-level Advanced Settings group to avoid a duplicate group/row, so it
   * opts out; the standalone glasses page keeps them.
   */
  showAdvancedGroup?: boolean
}

/**
 * The body of the device/glasses settings — every row is conditional on the
 * paired device's capabilities. Rendered both inline on the flattened main
 * settings page and on the standalone /miniapps/settings/glasses route.
 *
 * Returns null when no device is paired so embedding pages don't need a guard.
 */
export function DeviceSettingsSection({showDeviceHeader = true, showAdvancedGroup = true}: DeviceSettingsSectionProps) {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const hasDeviceInfo = useHasDeviceInfo()
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
    SETTINGS.default_button_action_enabled.key,
  )
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS.default_button_action_app.key)
  const glassesConnected = useGlassesStore(selectGlassesConnected)

  const {push} = useNavigationStore.getState()
  const applets = useApps()
  const features: Capabilities = getModelCapabilities(defaultWearable)

  const otaProgress = useGlassesStore((state) => state.otaProgress)

  const confirmForgetGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:forgetGlasses"),
      message: translate("settings:forgetGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:unpair")}],
      options: {allowDismiss: false},
    })
    if (result === 1) {
      BluetoothSdk.forget()
    }
  }

  const confirmDisconnectGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:disconnectGlassesTitle"),
      message: translate("settings:disconnectGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:disconnect")}],
      options: {allowDismiss: false},
    })

    if (result === 1) {
      BluetoothSdk.disconnect()
    }
  }

  // Check if no glasses are paired at all — no device section to show.
  if (!defaultWearable) {
    return null
  }

  return (
    <View className="gap-6">
      {showDeviceHeader && (
        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-semibold text-foreground">{formatGlassesTitle(defaultWearable)}</Text>
          {defaultWearable !== DeviceTypes.SIMULATED && (
            <Image source={getGlassesImage(defaultWearable)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
          )}
        </View>
      )}

      {/* Reconnect affordances when paired but not connected */}
      {!glassesConnected && <ConnectDeviceButton />}
      {!glassesConnected && <NotConnectedInfo />}

      {superMode && (
        <RouteButton label={translate("settings:layoutSettings")} onPress={() => push("/miniapps/settings/layout")} />
      )}

      {/* Screen settings for binocular glasses */}
      <Group title={translate("deviceSettings:display")}>
        {defaultWearable && (features?.display?.count ?? 0 > 1) && (
          <RouteButton
            icon={<Icon name="locate" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:positionSettings")}
            onPress={() => push("/miniapps/settings/position")}
          />
        )}
        {/* Only show dashboard settings if glasses have display capability */}
        {defaultWearable && features?.hasDisplay && (
          <RouteButton
            icon={<Icon name="layout-dashboard" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:dashboardSettings")}
            onPress={() => push("/miniapps/settings/dashboard")}
          />
        )}
        {/* Glasses Menu — G2 only, requires connection */}
        {defaultWearable === DeviceTypes.G2 && glassesConnected && (
          <RouteButton
            icon={<Icon name="menu-2" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:glassesMenu")}
            onPress={() => push("/miniapps/settings/glasses-menu")}
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

      {/* Nex Developer Settings - Only show when connected to Mentra Display */}
      {defaultWearable && defaultWearable.includes(DeviceTypes.NEX) && (
        <RouteButton
          label="Nex Developer Settings"
          subtitle="Advanced developer tools and debugging features"
          onPress={() => push("/glasses/nex-developer-settings")}
        />
      )}

      {/* Button Settings - Mentra Live only (G2's button is a touchpad and conflicts with the native menu) */}
      {glassesConnected && defaultWearable === DeviceTypes.LIVE && (
        <ButtonSettings
          enabled={defaultButtonActionEnabled}
          selectedApp={defaultButtonActionApp}
          applets={applets}
          onEnabledChange={setDefaultButtonActionEnabled}
          onAppChange={setDefaultButtonActionApp}
        />
      )}

      {/* Only show WiFi settings if connected glasses support WiFi */}
      {glassesConnected && features?.hasWifi && (
        <RouteButton
          icon={<Icon name="wifi" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("settings:glassesWifiSettings")}
          onPress={() => {
            push("/wifi/scan")
          }}
        />
      )}

      {/* OTA Progress Section - Only show for OTA-capable glasses in super mode */}
      {superMode && glassesConnected && features?.hasOta && <OtaProgressSection otaProgress={otaProgress} />}

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
            label={translate("deviceSettings:forgetGlasses")}
            onPress={confirmForgetGlasses}
          />
        )}

        {superMode && (
          <RouteButton
            icon={<Icon name="bluetooth" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:pairController")}
            onPress={() => push("/pairing/select-controller")}
          />
        )}
      </Group>

      {showAdvancedGroup && (
        <Group title={translate("deviceSettings:advancedSettings")}>
          {hasDeviceInfo && (
            <RouteButton
              icon={<Icon name="device-ipad" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("deviceSettings:deviceInformation")}
              onPress={() => push("/miniapps/settings/device-info")}
            />
          )}
          <RouteButton
            icon={<Icon name="microphone" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:microphone")}
            onPress={() => push("/miniapps/settings/microphone")}
          />
        </Group>
      )}

      {/* this just gives the user a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}
