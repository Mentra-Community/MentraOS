import {ScrollView, Image, View} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Header, Screen, Icon} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"

import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule from "core"

import OtaProgressSection from "@/components/glasses/OtaProgressSection"
import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {EmptyState} from "@/components/glasses/info/EmptyState"
import {ButtonSettings} from "@/components/glasses/settings/ButtonSettings"
import BrightnessSetting from "@/components/settings/BrightnessSetting"
import {useApplets, useAppletStatusStore} from "@/stores/applets"
// import showAlert from "@/utils/AlertUtils"
import {showAlert} from "@/contexts/ModalContext"

function DeviceSettings() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
    SETTINGS.default_button_action_enabled.key,
  )
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS.default_button_action_app.key)
  const glassesConnected = useGlassesStore((state) => state.connected)

  const {push, goBack} = useNavigationHistory()
  const applets = useApplets()
  const features: Capabilities = getModelCapabilities(defaultWearable)

  const wifiLocalIp = useGlassesStore((state) => state.wifiSsid)
  const bluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const otaProgress = useGlassesStore((state) => state.otaProgress)

  const hasDeviceInfo = Boolean(bluetoothName || buildNumber || wifiLocalIp)

  const confirmForgetGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:forgetGlasses"),
      message: translate("settings:forgetGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:unpair")}],
      options: {allowDismiss: false},
    })
    if (result === 1) {
      CoreModule.forget()
      useAppletStatusStore.getState().stopAllApplets()
      useAppletStatusStore.getState().refreshApplets()
      // give us a second to forget the glasses before going back
      setTimeout(() => {
        goBack()
      }, 500)
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
      CoreModule.disconnect()
    }
  }

  // Check if no glasses are paired at all
  if (!defaultWearable) {
    return <EmptyState />
  }

  return (
    <View className="gap-6">
      {superMode && (
        <RouteButton label={translate("settings:layoutSettings")} onPress={() => push("/miniapps/settings/layout")} />
      )}

      {/* Screen settings for binocular glasses */}
      <Group
        title={translate("deviceSettings:display")}
        // subtitle={translate("settings:screenDescription")}
      >
        {defaultWearable && (features?.display?.count ?? 0 > 1) && (
          <RouteButton
            icon={<Icon name="locate" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:positionSettings")}
            // subtitle={translate("settings:screenDescription")}
            onPress={() => push("/miniapps/settings/position")}
          />
        )}
        {/* Only show dashboard settings if glasses have display capability */}
        {defaultWearable && features?.hasDisplay && (
          <RouteButton
            icon={<Icon name="layout-dashboard" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("settings:dashboardSettings")}
            // subtitle={translate("settings:dashboardDescription")}
            onPress={() => push("/miniapps/settings/dashboard")}
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
          // icon={}
          label="Nex Developer Settings"
          subtitle="Advanced developer tools and debugging features"
          onPress={() => push("/glasses/nex-developer-settings")}
        />
      )}
      {/* Mic selector has been moved to Advanced Settings section below */}

      {/* Camera Settings button moved to Gallery Settings page */}

      {/* Button Settings - Only show for glasses with configurable buttons */}
      {glassesConnected && defaultWearable && features?.hasButton && (
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

      {/* Device info is rendered within the Advanced Settings section below */}

      {/* OTA Progress Section - Only show for Mentra Live glasses */}
      {glassesConnected && defaultWearable.includes(DeviceTypes.LIVE) && (
        <OtaProgressSection otaProgress={otaProgress} />
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
        {hasDeviceInfo && (
          <RouteButton
            icon={<Icon name="device-ipad" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:deviceInformation")}
            onPress={() => push("/miniapps/settings/device-info")}
          />
        )}
      </Group>

      {/* this just gives the user a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}

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
    if (defaultWearable !== DeviceTypes.SIMULATED) {
      glassesComponent = (
        <Image source={getGlassesImage(defaultWearable)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
      )
    }
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
