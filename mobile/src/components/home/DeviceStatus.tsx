import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule, {GlassesNotReadyEvent} from "core"
import {useState, useEffect} from "react"
import {ActivityIndicator, Image, TouchableOpacity, View, ViewStyle} from "react-native"
import GlassView from "@/components/ui/GlassView"
import {Button, Icon, Text} from "@/components/ignite"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {useSearchingState} from "@/hooks/useSearchingState"
import {SETTINGS, useSetting} from "@/stores/settings"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {
  getEvenRealitiesG1Image,
  getGlassesClosedImage,
  getGlassesImage,
  getGlassesOpenImage,
} from "@/utils/getGlassesImage"

import MicIcon from "assets/icons/component/MicIcon"
import {useCoreStore} from "@/stores/core"

const getBatteryIcon = (batteryLevel: number): string => {
  if (batteryLevel >= 75) return "battery-3"
  if (batteryLevel >= 50) return "battery-2"
  if (batteryLevel >= 25) return "battery-1"
  return "battery-0"
}

export const DeviceStatus = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const glassesConnectionState = useGlassesStore((state) => state.connectionState)
  const glassesStyle = useGlassesStore((state) => state.style)
  const color = useGlassesStore((state) => state.color)
  const caseRemoved = useGlassesStore((state) => state.caseRemoved)
  const caseBatteryLevel = useGlassesStore((state) => state.caseBatteryLevel)
  const caseOpen = useGlassesStore((state) => state.caseOpen)
  const batteryLevel = useGlassesStore((state) => state.batteryLevel)
  const charging = useGlassesStore((state) => state.charging)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const searching = useCoreStore((state) => state.searching)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  // Listen for glasses_not_ready event to know when glasses are actually booting
  useEffect(() => {
    const sub = CoreModule.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  // Reset booting state when glasses become fully booted or disconnected
  useEffect(() => {
    if (glassesFullyBooted || !glassesConnected) {
      setShowGlassesBooting(false)
    }
  }, [glassesFullyBooted, glassesConnected])

  const {wasSearching, nativeLinkBusy, resetSearching} = useSearchingState(searching, glassesConnectionState)

  if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return <ConnectedSimulatedGlassesInfo style={style} mirrorStyle={{backgroundColor: theme.colors.background}} />
  }

  const connectGlasses = async () => {
    if (!defaultWearable) {
      push("/pairing/select-glasses-model")
      return
    }

    // setIsCheckingConnectivity(true)

    try {
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }
    } catch (error) {
      console.error("connect to glasses error:", error)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    } finally {
      // setIsCheckingConnectivity(false)
    }
    await CoreModule.connectDefault()
  }

  const handleConnectOrDisconnect = async () => {
    if (searching || nativeLinkBusy) {
      await CoreModule.disconnect()
      setIsCheckingConnectivity(false)
      resetSearching()
    } else {
      await connectGlasses()
    }
  }

  const getCurrentGlassesImage = () => {
    let image = getGlassesImage(defaultWearable)

    if (defaultWearable === DeviceTypes.G1) {
      let state = "folded"
      if (!caseRemoved) {
        state = caseOpen ? "case_open" : "case_close"
      }
      return getEvenRealitiesG1Image(glassesStyle, color, state, "l", theme.isDark, caseBatteryLevel)
    }

    if (!caseRemoved) {
      image = caseOpen ? getGlassesOpenImage(defaultWearable) : getGlassesClosedImage(defaultWearable)
    }

    return image
  }

  let isSearching = searching || isCheckingConnectivity || wasSearching || nativeLinkBusy
  let connectingText = translate("home:connectingGlasses")
  // Only show booting message when we've received a glasses_not_ready event
  if (showGlassesBooting) {
    connectingText = "Glasses are booting..."
  } else if (nativeLinkBusy && !searching) {
    connectingText = translate("glasses:glassesAreReconnecting")
  }

  const features = getModelCapabilities(defaultWearable)

  if (!glassesConnected || !glassesFullyBooted || isSearching) {
    return (
      <TouchableOpacity onPress={() => push("/miniapps/settings/glasses")} className="h-28">
        <GlassView className="bg-primary-foreground px-6 justify-center flex-1 rounded-2xl flex-row gap-2">
          <View className="flex-1 self-start justify-center h-full">
            <Image
              source={getCurrentGlassesImage()}
              className="w-full max-w-40 h-28 self-start"
              style={{resizeMode: "contain"}}
            />
          </View>

          <View className="w-1/2">
            <View className="items-end flex-col gap-3 justify-center flex-1">
              <View className="flex-row items-center gap-3">
                <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
                <Text className="font-semibold text-secondary-foreground text-end self-end" text={defaultWearable} />
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
                    <Text
                      className="text-secondary-foreground"
                      style={{fontSize: 14}}
                      text={translate("common:cancel")}
                    />
                  </View>
                </Button>
              )}
            </View>
          </View>
        </GlassView>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity onPress={() => push("/miniapps/settings/glasses")} className="h-28">
      <GlassView className="bg-primary-foreground px-6 py-0 justify-center flex rounded-2xl flex-row gap-2">
        <View className="w-[42%] max-w-40 shrink-0 self-start justify-center h-full">
          <Image source={getCurrentGlassesImage()} className="w-full h-28 self-start" style={{resizeMode: "contain"}} />
        </View>

        <View className="flex-1 min-w-0 justify-center">
          <View className="items-end flex-col gap-3 justify-center flex-1">
            <Text className="font-semibold text-secondary-foreground text-base" text={defaultWearable} />
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
                  <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                    <Icon name="wifi" size={18} color={theme.colors.foreground} />
                  </Button>
                ) : (
                  <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                    <Icon name="wifi-off" size={18} color={theme.colors.foreground} />
                  </Button>
                ))}
            </View>
          </View>
        </View>
      </GlassView>
    </TouchableOpacity>
  )
}
