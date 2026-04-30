import {DeviceTypes} from "@/../../cloud/packages/types/src"
import CoreModule from "core"
import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {View, TouchableOpacity, Platform, ScrollView, Image} from "react-native"

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

export default function SelectGlassesModelScreen() {
  const {theme, themed} = useAppTheme()
  const {push, goBack} = useNavigationHistory()
  const [superMode] = useSetting(SETTINGS.super_mode.key)

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

  // Glasses models that should only be visible in super mode.
  const SUPER_MODE_ONLY_MODELS = new Set<string>([DeviceTypes.NEX])

  // Platform-specific glasses options
  const glassesOptions =
    Platform.OS === "ios"
      ? [
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
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
          {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
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
    <Screen preset="fixed" extraAndroidInsets>
      <Header
        titleTx="pairing:selectModel"
        leftIcon="chevron-left"
        onLeftPress={() => {
          goBack()
        }}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <Spacer className="h-4" />
      <ScrollView className="-mx-6 px-6 pt-6">
        <View className="flex-col gap-4 pb-8">
          {glassesOptions
            .filter((glasses) => !SUPER_MODE_ONLY_MODELS.has(glasses.deviceModel) || superMode)
            .map((glasses) => (
              <TouchableOpacity key={glasses.key} onPress={() => triggerGlassesPairingGuide(glasses.deviceModel)}>
                <GlassView className="bg-primary-foreground border border-background flex-col items-center justify-center p-6 rounded-2xl overflow-hidden">
                  <View className="flex-row gap-4">
                    <View className="flex-col flex-1 justify-center">
                      <View className="justify-center min-h-6">
                        {getManufacturerLogo(glasses.deviceModel)}
                      </View>
                      <Text className="text-2xl text-foreground font-medium" text={glasses.deviceModel} />
                    </View>
                    <Image
                      source={getGlassesImage(glasses.deviceModel)}
                      className="w-[90px] max-h-[80px] object-contain"
                    />
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
