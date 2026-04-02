import {DeviceTypes, ControllerTypes} from "@/../../cloud/packages/types/src"
import CoreModule from "core"
import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {View, TouchableOpacity, Platform, ScrollView, Image, ViewStyle, ImageStyle, TextStyle} from "react-native"

import {EvenRealitiesLogo} from "@/components/brands/EvenRealitiesLogo"
import {MentraLogo} from "@/components/brands/MentraLogo"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {VuzixLogo} from "@/components/brands/VuzixLogo"
import {Text, Header} from "@/components/ignite"
import {Screen} from "@/components/ignite/Screen"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"
import GlassView from "@/components/ui/GlassView"

// import {useLocalSearchParams} from "expo-router"

export default function SelectControllerScreen() {
  const {theme} = useAppTheme()
  const {push, goBack} = useNavigationHistory()

  // when this screen is focused, forget any glasses that may be paired:
  useFocusEffect(
    useCallback(() => {
      // CoreModule.forget()
      return () => {}
    }, []),
  )

  // Get logo component for manufacturer
  const getManufacturerLogo = (deviceModel: string) => {
    switch (deviceModel) {
      case DeviceTypes.G1:
      case DeviceTypes.G2:
        return <EvenRealitiesLogo color={theme.colors.text} />
      case DeviceTypes.LIVE:
      case DeviceTypes.NEX:
      case DeviceTypes.MACH1:
        return <MentraLogo color={theme.colors.text} />
      case DeviceTypes.Z100:
        return <VuzixLogo color={theme.colors.text} />
      default:
        return null
    }
  }

  // Platform-specific glasses options
  const controllerOptions =
    Platform.OS === "ios"
      ? [
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          //{deviceModel: "Brilliant Labs Frame", key: "frame"},
          {deviceModel: ControllerTypes.R1, key: "evenrealities_r1"},
        ]
      : [
          // Android:
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
        ]

  const triggerGlassesPairingGuide = async (deviceModel: string) => {
    push("/pairing/prep-controller", {deviceModel: deviceModel})
  }

  return (
    <Screen preset="fixed">
      <Header
        titleTx="pairing:selectModel"
        leftIcon="chevron-left"
        onLeftPress={() => {
          goBack()
        }}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <Spacer className="h-4" />
      <ScrollView className="-mr-4 pr-4 pt-6">
        <View className="flex-col gap-4 pb-8">
          {controllerOptions.map((controller) => (
            <TouchableOpacity key={controller.key} onPress={() => triggerGlassesPairingGuide(controller.deviceModel)}>
              <GlassView className="bg-primary-foreground flex-col items-center justify-center h-[190px] rounded-2xl overflow-hidden">
                <View className="flex-col items-center justify-center gap-3 w-full">
                  <View className="items-center justify-center min-h-6">
                    {getManufacturerLogo(controller.deviceModel)}
                  </View>
                  <Image
                    source={getGlassesImage(controller.deviceModel)}
                    className="w-[180px] max-h-[80px] object-contain"
                  />
                  <Text className="text-[16px] text-foreground" text={controller.deviceModel} />
                </View>
              </GlassView>
            </TouchableOpacity>
          ))}
          <Spacer height={theme.spacing.s4} />
        </View>
      </ScrollView>
    </Screen>
  )
}
