import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import type {GlassesNotReadyEvent} from "@mentra/engine"
import {useState, useEffect, type ReactNode} from "react"
import {ActivityIndicator, Image, TouchableOpacity, View, type ImageSourcePropType, type ViewStyle} from "react-native"
import GlassView from "@/components/ui/GlassView"
import {Button, Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {decideConnectButtonAction, engine} from "@mentra/engine"
import {useSearchingState} from "@/hooks/useSearchingState"
import {SETTINGS, useSetting} from "@mentra/engine"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {
  getAr99DisplayName,
  getAr99ImageSource,
  getEvenRealitiesG1Image,
  getGlassesClosedImage,
  getGlassesImage,
  getGlassesOpenImage,
} from "@/utils/getGlassesImage"

import MicIcon from "assets/icons/component/MicIcon"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"

const getBatteryIcon = (batteryLevel: number): string => {
  if (batteryLevel >= 75) return "battery-3"
  if (batteryLevel >= 50) return "battery-2"
  if (batteryLevel >= 25) return "battery-1"
  return "battery-0"
}

/**
 * Shared shell for device status cards (glasses, controllers, etc).
 * Renders the outer touchable + GlassView + image column, and slots
 * the right-hand content via children.
 */
type DeviceStatusProps = {
  onPress: () => void
  image: ImageSourcePropType
  children: ReactNode
  className?: string
}

export const DeviceStatus = ({onPress, image, children, className = "h-28"}: DeviceStatusProps) => {
  return (
    <TouchableOpacity onPress={onPress} className={className}>
      <GlassView className="px-6 justify-center flex-1 rounded-2xl flex-row gap-2 h-full">
        <View className="w-[42%] max-w-40 shrink-0 self-start justify-center h-full">
          <Image source={image} className="w-full max-w-40 h-28 self-start" style={{resizeMode: "contain"}} />
        </View>
        <View className="flex-1 min-w-0 justify-center">
          <View className="items-end flex-col gap-3 justify-center flex-1">{children}</View>
        </View>
      </GlassView>
    </TouchableOpacity>
  )
}

export const GlassesStatus = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  // Pairing-identity read-model: none | pending (chosen, never paired) | paired.
  const identity = useEngineSnapshot(engine.pairing.identity, (onChange) => engine.pairing.onIdentity(onChange))
  const pairedModel = identity.kind === "paired" ? identity.model : ""
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const glassesStatus = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const glassesInfo = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange))
  const pairingReadiness = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  )
  const wifiStatus = useEngineSnapshot(engine.glasses.wifi.status, (onChange) =>
    engine.glasses.wifi.onStatus(onChange),
  )
  const glassesConnected = glassesStatus.state === "connected"
  const glassesFullyBooted = glassesStatus.fullyBooted
  const glassesStyle = glassesInfo.style
  const color = glassesInfo.color
  const caseRemoved = glassesStatus.case.removed
  const caseBatteryLevel = glassesStatus.case.battery
  const caseOpen = glassesStatus.case.open
  const batteryLevel = glassesStatus.battery
  const charging = glassesStatus.charging
  const [projectName] = useSetting<string>(SETTINGS.project_name.key)
  const wifiConnected = wifiStatus.state === "connected"
  const searching = useEngineSnapshot(engine.pairing.scanning, (onChange) => engine.pairing.onScanning(onChange))
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  // Listen for glasses_not_ready event to know when glasses are actually booting
  useEffect(() => {
    const unsub = engine.pairing.onGlassesNotReady((_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      unsub()
    }
  }, [])

  // Reset booting state when glasses become fully booted or disconnected
  useEffect(() => {
    if (glassesFullyBooted || !glassesConnected) {
      setShowGlassesBooting(false)
    }
  }, [glassesFullyBooted, glassesConnected])

  const {wasSearching, nativeLinkBusy, resetSearching} = useSearchingState(searching, pairingReadiness.nativeLinkBusy)

  if (pairedModel.includes(DeviceTypes.SIMULATED)) {
    return (
      <GlassView className="bg-primary-foreground p-5" style={style}>
        <View className="flex-row justify-between items-center mb-4">
          <Text className="font-semibold text-secondary-foreground text-lg" tx="onboarding:phoneMode" />
        </View>
        <GlassesDisplayMirror fallbackMessage="Glasses mirror" style={{backgroundColor: theme.colors.background}} />
        {/* <TouchableOpacity style={{position: "absolute", bottom: 10, right: 10}} onPress={navigateToFullScreen}>
          <Icon name="fullscreen" size={24} color={theme.colors.secondary_foreground} />
        </TouchableOpacity> */}
        <Button
          className="mt-3"
          flex={false}
          flexContainer={false}
          tx="home:connectGlasses"
          preset="primary"
          onPress={() => push("/pairing/select-glasses-model", {transition: "simple_push"})}
        />
      </GlassView>
    )
  }

  const connectGlasses = async () => {
    if (!pairedModel) {
      // A pending selection resumes its own scan (including the mid-pairing
      // window where the link is up but promotion hasn't echoed yet); only a
      // truly identity-less state starts over at model selection.
      if (identity.kind === "pending") {
        if (identity.model === DeviceTypes.AR99) {
          push("/pairing/select-glasses-model", {transition: "simple_push"})
        } else {
          push("/pairing/scan", {deviceModel: identity.model})
        }
      } else {
        push("/pairing/select-glasses-model", {transition: "simple_push"})
      }
      return
    }

    try {
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }
      // A `paired` identity snapshot does not imply a native device to connect
      // to (the settings echo can outlive the native pairing). Without a
      // native default device, connectDefault() throws — route back into
      // pairing for the already-selected model instead of erroring. Fail open
      // on a read error: connectDefault()'s catch is the pre-guard behavior.
      if (!(await engine.glasses.hasDefaultDevice().catch(() => true))) {
        if (pairedModel === DeviceTypes.AR99) {
          push("/pairing/select-glasses-model", {transition: "simple_push"})
        } else {
          push("/pairing/scan", {deviceModel: pairedModel})
        }
        return
      }
      await engine.glasses.connectDefault()
    } catch (error) {
      console.error("connect to glasses error:", error)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    }
  }

  const handleConnectOrDisconnect = async () => {
    const action = decideConnectButtonAction({hasDefaultWearable: !!pairedModel, busy: searching || nativeLinkBusy})
    if (action === "cancel") {
      await engine.glasses.disconnect()
      setIsCheckingConnectivity(false)
      resetSearching()
    } else {
      await connectGlasses()
    }
  }

  // Pending selection: a model was chosen but pairing never completed (abandoned
  // mid-flow, or an orphaned identity demoted at boot). Offer to finish pairing
  // that model — or start over with a different one — instead of a Connect
  // button that has no device to connect to.
  //
  // NOT when the glasses are already connected: right after a promotion, the
  // BLE link is up while the save_setting echoes are still landing, so the JS
  // identity is momentarily still `pending` — render the normal connected card
  // (with the pending model as its display name) instead of finish-pairing
  // actions for a device that is already paired and connected.
  if (identity.kind === "pending" && !glassesConnected) {
    return (
      <View style={style}>
        <DeviceStatus
          onPress={() =>
            identity.model === DeviceTypes.AR99
              ? push("/pairing/select-glasses-model", {transition: "simple_push"})
              : push("/pairing/scan", {deviceModel: identity.model})
          }
          image={getGlassesImage(identity.model)}>
          <View className="flex-row items-center gap-3">
            <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
            <Text className="font-semibold text-secondary-foreground text-end self-end" text={identity.model} />
          </View>
          <Button
            flex
            compact
            className="max-h-10"
            tx="home:finishPairingGlasses"
            preset="primary"
            onPress={() =>
              identity.model === DeviceTypes.AR99
                ? push("/pairing/select-glasses-model", {transition: "simple_push"})
                : push("/pairing/scan", {deviceModel: identity.model})
            }
          />
        </DeviceStatus>
        <Button
          className="mt-2"
          compact
          preset="secondary"
          tx="home:pairDifferentGlasses"
          onPress={() => push("/pairing/select-glasses-model", {transition: "simple_push"})}
        />
      </View>
    )
  }

  // The card body's model name/image: the paired model, or — in the mid-relay
  // window above (connected while the promotion echoes land) — the pending one.
  const displayModel = pairedModel || (identity.kind === "pending" ? identity.model : "")
  const displayName = displayModel === DeviceTypes.AR99 ? getAr99DisplayName(projectName) : displayModel

  const getCurrentGlassesImage = () => {
    let image = displayModel === DeviceTypes.AR99 ? getAr99ImageSource(projectName) : getGlassesImage(displayModel)

    if (displayModel === DeviceTypes.G1) {
      let state = "folded"
      if (!caseRemoved) {
        state = caseOpen ? "case_open" : "case_close"
      }
      return getEvenRealitiesG1Image(glassesStyle, color, state, "l", theme.isDark, caseBatteryLevel)
    }

    if (!caseRemoved) {
      image = caseOpen ? getGlassesOpenImage(displayModel) : getGlassesClosedImage(displayModel)
    }

    return image
  }

  let isSearching = searching || isCheckingConnectivity || wasSearching || nativeLinkBusy
  let _connectingText = translate("home:connectingGlasses")
  // Only show booting message when we've received a glasses_not_ready event
  if (showGlassesBooting) {
    _connectingText = "Glasses are booting..."
  } else if (nativeLinkBusy && !searching) {
    _connectingText = translate("glasses:glassesAreReconnecting")
  }

  const features = getModelCapabilities(displayModel as DeviceTypes)
  const onPress = () => push("/miniapps/settings/main", {transition: "simple_push"})

  if (!glassesConnected || !glassesFullyBooted || isSearching) {
    return (
      <DeviceStatus onPress={onPress} image={getCurrentGlassesImage()}>
        <View className="flex-row items-center gap-3">
          <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
          <Text className="font-semibold text-secondary-foreground text-end self-end" text={displayName} />
        </View>
        {!isSearching && (
          <Button
            flex
            compact
            className="max-h-10"
            tx="home:connectGlasses"
            preset="primary"
            onPress={connectGlasses}
          />
        )}
        {isSearching && (
          <Button
            flex
            compact
            className="w-[80%] max-h-10 items-center justify-center"
            preset="alternate"
            onPress={handleConnectOrDisconnect}>
            <View className="flex-row items-center gap-2 flex-1">
              <ActivityIndicator size="small" color={theme.colors.foreground} />
              <Text className="text-secondary-foreground" style={{fontSize: 14}} text={translate("common:cancel")} />
            </View>
          </Button>
        )}
      </DeviceStatus>
    )
  }

  return (
    <DeviceStatus onPress={onPress} image={getCurrentGlassesImage()}>
      <Text className="font-semibold text-secondary-foreground text-base" text={displayName} />
      <View className="flex-row items-center gap-3">
        {batteryLevel !== -1 && (
          <View className="flex-row items-center gap-1">
            <Icon
              name={charging ? "battery-charging" : (getBatteryIcon(batteryLevel) as any)}
              size={22}
              color={theme.colors.foreground}
            />
            <Text className="text-secondary-foreground text-sm" text={`${batteryLevel}%`} />
          </View>
        )}
        <MicIcon width={18} height={18} />
        <Icon name="bluetooth-connected" size={22} color={theme.colors.foreground} />
        {features?.hasWifi &&
          (wifiConnected ? (
            <Button
              compactIcon
              className="bg-transparent -m-2"
              onPress={() => push("/wifi/scan", {transition: "simple_push"})}>
              <Icon name="wifi" size={18} color={theme.colors.foreground} />
            </Button>
          ) : (
            <Button
              compactIcon
              className="bg-transparent -m-2"
              onPress={() => push("/wifi/scan", {transition: "simple_push"})}>
              <Icon name="wifi-off" size={18} color={theme.colors.foreground} />
            </Button>
          ))}
      </View>
    </DeviceStatus>
  )
}

export const ControllerStatus = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const controllerStatus = useEngineSnapshot(engine.glasses.controller.status, (onChange) =>
    engine.glasses.controller.onStatus(onChange),
  )
  const controllerConnected = controllerStatus.connected
  const controllerFullyBooted = controllerStatus.fullyBooted
  const controllerBatteryLevel = controllerStatus.battery
  const isSearching = useEngineSnapshot(engine.pairing.scanningController, (onChange) =>
    engine.pairing.onScanningController(onChange),
  )

  const handleConnectOrDisconnect = async () => {
    if (isSearching) {
      await engine.glasses.controller.disconnect()
    } else {
      await engine.glasses.controller.connectDefault()
    }
  }

  const getCurrentGlassesImage = () => getGlassesImage(defaultController)

  if (!defaultController) {
    return null
  }

  const onPress = () => push("/miniapps/settings/controller", {transition: "simple_push"})

  if (!controllerConnected || !controllerFullyBooted) {
    return (
      <DeviceStatus onPress={onPress} image={getCurrentGlassesImage()} className="h-28 mt-2">
        <View className="flex-row items-center gap-3">
          <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
          <Text className="font-semibold text-secondary-foreground text-end self-end" text={defaultController} />
        </View>
        {!isSearching && (
          <Button
            flex
            compact
            className="max-h-10"
            tx="home:connectRing"
            preset="primary"
            onPress={handleConnectOrDisconnect}
          />
        )}
        {isSearching && (
          <Button
            flex
            compact
            className="w-[80%] max-h-10 items-center justify-center"
            preset="alternate"
            onPress={handleConnectOrDisconnect}>
            <View className="flex-row items-center gap-2 flex-1">
              <ActivityIndicator size="small" color={theme.colors.foreground} />
              <Text className="text-secondary-foreground" style={{fontSize: 14}} text={translate("common:cancel")} />
            </View>
          </Button>
        )}
      </DeviceStatus>
    )
  }

  return (
    <DeviceStatus onPress={onPress} image={getCurrentGlassesImage()} className="h-28 mt-2">
      <Text className="font-semibold text-secondary-foreground text-base" text={defaultController} />
      <View className="flex-row items-center gap-3">
        {controllerBatteryLevel !== -1 && (
          <View className="flex-row items-center gap-1">
            <Icon name={getBatteryIcon(controllerBatteryLevel) as any} size={22} color={theme.colors.foreground} />
            <Text className="text-secondary-foreground text-sm" text={`${controllerBatteryLevel}%`} />
          </View>
        )}
        <Icon name="bluetooth-connected" size={22} color={theme.colors.foreground} />
      </View>
    </DeviceStatus>
  )
}








