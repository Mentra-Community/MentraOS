import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule, {GlassesNotReadyEvent} from "core"
import {useState, useEffect} from "react"
import {ActivityIndicator, Image, Linking, TouchableOpacity, View, ViewStyle} from "react-native"
import GlassView from "@/components/ui/GlassView"
import {Button, Icon, Text} from "@/components/ignite"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
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

export const ControllerStatus = ({style}: {style?: ViewStyle}) => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const controllerConnected = useGlassesStore((state) => state.controllerConnected)
  const controllerFullyBooted = useGlassesStore((state) => state.controllerFullyBooted)
  const features = getModelCapabilities(defaultController)
  const controllerBatteryLevel = useGlassesStore((state) => state.controllerBatteryLevel)
  const isSearching = useCoreStore((state) => state.searchingController)

  const handleConnectOrDisconnect = async () => {
    if (isSearching) {
      await CoreModule.disconnectController()
    } else {
      await CoreModule.connectDefaultController()
    }
  }

  const getCurrentGlassesImage = () => {
    let image = getGlassesImage(defaultController)
    return image
  }

  if (!defaultController) {
    return null
  }

  if (!controllerConnected || !controllerFullyBooted) {
    return (
      <TouchableOpacity onPress={() => push("/miniapps/settings/controller")} className="h-28">
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
    <TouchableOpacity onPress={() => push("/miniapps/settings/controller")} className="h-28">
      <GlassView className="bg-primary-foreground px-6 py-0 justify-center flex rounded-2xl flex-row gap-2">
        <View className="flex-1 self-start justify-center h-full">
          <Image
            source={getCurrentGlassesImage()}
            className="w-full max-w-40 h-28 self-start"
            style={{resizeMode: "contain"}}
          />
        </View>

        <View className="w-1/2">
          <View className="items-end flex-col gap-3 justify-center flex-1">
            <Text className="font-semibold text-secondary-foreground text-base" text={defaultController} />
            <View className="flex-row items-center gap-3">
              {controllerBatteryLevel !== -1 && (
                <View className="flex-row items-center gap-1">
                  <Icon
                    name={
                      controllerBatteryLevel > 0 ? "battery-charging" : (getBatteryIcon(controllerBatteryLevel) as any)
                    }
                    size={22}
                    color={theme.colors.foreground}
                  />
                  <Text className="text-secondary-foreground text-sm" text={`${controllerBatteryLevel}%`} />
                </View>
              )}
              <Icon name="bluetooth-connected" size={22} color={theme.colors.foreground} />
            </View>
          </View>
        </View>
      </GlassView>
    </TouchableOpacity>
  )
}
