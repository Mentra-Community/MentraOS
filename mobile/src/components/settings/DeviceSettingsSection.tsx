import {useEffect, useState} from "react"
import {Image, View} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Icon, Text} from "@/components/ignite"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {showAlert} from "@/contexts/ModalContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@mentra/engine"
import {getGlassesImage} from "@/utils/getGlassesImage"

import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {engine} from "@mentra/engine"

import OtaProgressSection from "@/components/glasses/OtaProgressSection"
import {Ar99OtaModal} from "@/components/settings/Ar99OtaModal"
import BrightnessSetting from "@/components/settings/BrightnessSetting"

const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())

const isAr99Identifier = (value: unknown): boolean => {
  return typeof value === "string" && value.toUpperCase().includes(DeviceTypes.AR99)
}

/**
 * Returns whether device-information rows (bluetooth name, build number, local
 * IP) are available. Lives here so the "Device info" row can be hosted by
 * whatever page embeds the device settings while keeping the glasses-store
 * wiring in one place.
 */
export function useHasDeviceInfo(): boolean {
  const glassesInfo = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange))
  const wifiLocalIp = glassesInfo.wifi.state === "connected" ? glassesInfo.wifi.localIp : undefined
  const bluetoothName = glassesInfo.bluetoothName
  const buildNumber = glassesInfo.buildNumber
  const model = glassesInfo.model
  const firmwareVersion = glassesInfo.firmwareVersion
  const serialNumber = glassesInfo.serialNumber
  const btMac = glassesInfo.btMac
  return Boolean(bluetoothName || buildNumber || wifiLocalIp || model || firmwareVersion || serialNumber || btMac)
}

/**
 * The device/glasses settings, rendered as a single flat card stack under the
 * paired device's name — matching Parth's flattened Settings design. Every row
 * is conditional on the device's capabilities; for a connected Even Realities
 * G1 the visible order is display position → dashboard → auto-brightness →
 * microphone → device info → disconnect → unpair (the design's reference
 * layout), with capability-specific rows (G2 menu, WiFi, OTA, Nex, Mentra Live
 * button, super-mode tools) slotting in where applicable.
 *
 * Embedded inline on the flattened main settings page. Returns null when no
 * device is paired.
 */
export function DeviceSettingsSection() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const hasDeviceInfo = useHasDeviceInfo()
  const glassesInfo = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange))
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  // Button-action settings are no longer surfaced in the UI — the action button always launches the
  // camera (forced at runtime in ButtonActions.tsx). See the commented-out ButtonSettings block below.
  // const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
  //   SETTINGS.default_button_action_enabled.key,
  // )
  // const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS.default_button_action_app.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [ar99OtaVisible, setAr99OtaVisible] = useState(false)
  const glassesStatus = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const otaSnapshot = useEngineSnapshot(engine.ota.snapshot, engine.ota.onSnapshot)
  const glassesConnected = glassesStatus.state === "connected"

  const {push} = useNavigationStore.getState()
  const features: Capabilities = getModelCapabilities(defaultWearable)

  const otaProgress = otaSnapshot.legacyProgress
  const isAr99Family =
    isAr99Identifier(defaultWearable) ||
    isAr99Identifier(glassesInfo.model) ||
    isAr99Identifier(glassesInfo.bluetoothName)
  const showAr99OtaEntry =
    glassesConnected &&
    (isAr99Identifier(defaultWearable) ||
      isAr99Identifier(glassesInfo.model) ||
      isAr99Identifier(glassesInfo.bluetoothName))

  useEffect(() => {
    if (!showAr99OtaEntry && ar99OtaVisible) {
      setAr99OtaVisible(false)
    }
  }, [ar99OtaVisible, showAr99OtaEntry])

  const confirmForgetGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:forgetGlasses"),
      message: translate("settings:forgetGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:unpair")}],
      options: {allowDismiss: false},
    })
    if (result !== 1) {
      return
    }
    try {
      await engine.glasses.forget()
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String((error as {code?: unknown}).code) : ""
      // Native refuses forget() while Mentra Live CTKD is waiting on the system pairing dialog.
      if (code === "ctkd_bonding_in_progress") {
        await showAlert({
          title: translate("settings:forgetGlasses"),
          message: translate("settings:forgetGlassesWhilePairing"),
          buttons: [{text: translate("common:ok")}],
        })
        return
      }
      console.warn("Failed to forget glasses:", error)
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
      engine.glasses.disconnect()
    }
  }

  // No glasses paired at all — no device section to show.
  if (!defaultWearable) {
    return null
  }

  return (
    <View style={{gap: theme.spacing.s2}}>
      <View className="flex-row items-center justify-between">
        <Text>{formatGlassesTitle(defaultWearable)}</Text>
        {defaultWearable !== DeviceTypes.SIMULATED && (
          <Image source={getGlassesImage(defaultWearable)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
        )}
      </View>

      {/* Reconnect affordances when paired but not connected */}
      {!glassesConnected && <ConnectDeviceButton />}
      {!glassesConnected && <NotConnectedInfo />}

      {/* Display position — binocular glasses only */}
      {defaultWearable && !isAr99Family && (features?.display?.count ?? 0) > 1 && (
        <RouteButton
          icon={<Icon name="locate" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("settings:positionSettings")}
          onPress={() => push("/miniapps/settings/position")}
        />
      )}

      {/* Dashboard — glasses with a MentraOS-managed display dashboard only.
          Devices with a native firmware dashboard (e.g. G2) manage it on-device,
          so our dashboard settings don't apply. */}
      {defaultWearable && features?.hasDisplay && !features?.hasNativeDashboard && (
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

      {/* Auto-Brightness */}
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

      {/* Layout settings — super mode (display layout tooling) */}
      {superMode && (
        <RouteButton label={translate("settings:layoutSettings")} onPress={() => push("/miniapps/settings/layout")} />
      )}

      {/* Button Settings — Mentra Live only (G2's button is a touchpad and conflicts with the native menu).
          Hidden for now: the action button always launches the camera. ButtonActions.tsx already forces
          `default_button_action_app` to com.mentra.camera at runtime for any Mentra Live (camera) glasses, so
          there's nothing for the user to configure. Re-enable this block if we ship a real button-config UX. */}
      {/* {glassesConnected && defaultWearable === DeviceTypes.LIVE && (
        <ButtonSettings
          enabled={defaultButtonActionEnabled}
          selectedApp={defaultButtonActionApp}
          applets={applets}
          onEnabledChange={setDefaultButtonActionEnabled}
          onAppChange={setDefaultButtonActionApp}
        />
      )} */}

      {/* Microphone */}
      <RouteButton
        icon={<Icon name="microphone" size={24} color={theme.colors.secondary_foreground} />}
        label={translate("deviceSettings:microphone")}
        onPress={() => push("/miniapps/settings/microphone")}
      />

      {/* WiFi — connected glasses that support WiFi */}
      {showAr99OtaEntry && (
        <>
          <RouteButton
            icon={<Icon name="world-download" size={24} color={theme.colors.secondary_foreground} />}
            label="Firmware Update"
            onPress={() => setAr99OtaVisible(true)}
          />
          <Ar99OtaModal visible={ar99OtaVisible} onClose={() => setAr99OtaVisible(false)} />
        </>
      )}

      {glassesConnected && features?.hasWifi && (
        <RouteButton
          icon={<Icon name="wifi" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("settings:glassesWifiSettings")}
          onPress={() => {
            push("/wifi/scan")
          }}
        />
      )}

      {/* OTA Progress — OTA-capable glasses in super mode */}
      {superMode && glassesConnected && features?.hasOta && otaProgress?.progress && otaProgress?.progress < 100 && <OtaProgressSection otaProgress={otaProgress} />}

      {/* Nex Developer Settings — Mentra Display only */}
      {defaultWearable && defaultWearable.includes(DeviceTypes.NEX) && (
        <RouteButton
          label="Nex Developer Settings"
          subtitle="Advanced developer tools and debugging features"
          onPress={() => push("/glasses/nex-developer-settings")}
        />
      )}

      {/* Device info */}
      {hasDeviceInfo && (
        <RouteButton
          icon={<Icon name="device-ipad" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("deviceSettings:deviceInformation")}
          onPress={() => push("/miniapps/settings/device-info")}
        />
      )}

      {/* Disconnect glasses */}
      {glassesConnected && defaultWearable !== DeviceTypes.SIMULATED && (
        <RouteButton
          icon={<Icon name="unlink" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("deviceSettings:disconnectGlasses")}
          onPress={confirmDisconnectGlasses}
        />
      )}

      {/* Unpair glasses */}
      {defaultWearable && (
        <RouteButton
          icon={<Icon name="unplug" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("deviceSettings:forgetGlasses")}
          onPress={confirmForgetGlasses}
        />
      )}

      {/* Pair controller — super mode */}
      {superMode && (
        <RouteButton
          icon={<Icon name="bluetooth" size={24} color={theme.colors.secondary_foreground} />}
          label={translate("deviceSettings:pairController")}
          onPress={() => push("/pairing/select-controller")}
        />
      )}

      {/* a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}

