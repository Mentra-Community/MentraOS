import {DeviceTypes} from "@/../../cloud/packages/types/src"
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
import {ThemedStyle} from "@/theme"
import {getGlassesImage} from "@/utils/getGlassesImage"

// import {useLocalSearchParams} from "expo-router"

export default function SelectGlassesModelScreen() {
  const {theme, themed} = useAppTheme()
  const {push, goBack} = useNavigationHistory()
  const [devMode] = useSetting(SETTINGS.dev_mode.key)

  // when this screen is focused, forget any glasses that may be paired:
  useFocusEffect(
    useCallback(() => {
      CoreModule.forget()
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

  // Glasses models that should only be visible in dev mode
  const DEV_MODE_ONLY_MODELS = new Set([DeviceTypes.NEX])

  // Platform-specific glasses options
  const glassesOptions =
    Platform.OS === "ios"
      ? [
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          // {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
          //{deviceModel: "Brilliant Labs Frame", key: "frame"},
        ]
      : [
          // Android:
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          // {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
          // {deviceModel: "Brilliant Labs Frame", key: "frame"},
        ]

  const triggerGlassesPairingGuide = async (deviceModel: string) => {
    push("/pairing/prep", {deviceModel: deviceModel})
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
          {glassesOptions
            .filter((glasses) => !DEV_MODE_ONLY_MODELS.has(glasses.deviceModel) || devMode)
            .map((glasses) => (
            <TouchableOpacity
              key={glasses.key}
              className="flex-col items-center justify-center h-[190px] bg-primary-foreground rounded-2xl overflow-hidden"
              onPress={() => triggerGlassesPairingGuide(glasses.deviceModel)}>
              <View className="flex-col items-center justify-center gap-3 w-full">
                <View className="items-center justify-center min-h-6">{getManufacturerLogo(glasses.deviceModel)}</View>
                <Image
                  source={getGlassesImage(glasses.deviceModel)}
                  className="w-[180px] max-h-[80px] object-contain"
                />
                <Text className="text-[16px] text-foreground" text={glasses.deviceModel} />
              </View>
            </TouchableOpacity>
          ))}
          <Spacer height={theme.spacing.s4} />
        </View>
      </ScrollView>
    </Screen>
  )
}