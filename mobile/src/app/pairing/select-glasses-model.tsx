import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {View, TouchableOpacity, Platform, ScrollView, Image} from "react-native"

import {EvenRealitiesLogo} from "@/components/brands/EvenRealitiesLogo"
import {MentraLogo} from "@/components/brands/MentraLogo"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {NimoLogo} from "@/components/brands/NimoLogo"
import {VuzixLogo} from "@/components/brands/VuzixLogo"
import {Text, Header} from "@/components/ignite"
import {Screen} from "@/components/ignite/Screen"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"
import GlassView from "@/components/ui/GlassView"

// import {useLocalSearchParams} from "expo-router"

export default function SelectGlassesModelScreen() {
  const {theme} = useAppTheme()
  const {push, goBack} = useNavigationStore.getState()
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  // (This screen used to forget any paired glasses on focus. With two-phase
  // identity there is no eager default to clean up before a fresh pairing, and
  // the forget wiped REAL pairings whenever the screen was entered â€?or backed
  // into â€?while glasses were paired. Attempt cleanup now lives on the specific
  // abandon paths: scan back-out, pairing failure, and unpair-even retry.)

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
      case DeviceTypes.NIMO:
        return <NimoLogo />
      case DeviceTypes.AR99:
        return <Text text="Xingyi Intelligent" className="text-foreground font-semibold text-lg" />
      default:
        return null
    }
  }

  const getDisplayName = (deviceModel: string) => {
    switch (deviceModel) {
      case DeviceTypes.AR99:
        return "Xingyi AR99"
      default:
        return deviceModel
    }
  }

  // Glasses models that should only be visible in super mode.
  const SUPER_MODE_ONLY_MODELS = new Set<string>([DeviceTypes.NEX, DeviceTypes.NIMO])

  // Platform-specific glasses options
  const glassesOptions =
    Platform.OS === "ios"
      ? [
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.AR99, key: "ar99"},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
          {deviceModel: DeviceTypes.NIMO, key: "nimo"},
          //{deviceModel: "Brilliant Labs Frame", key: "frame"},
        ]
      : [
          // Android:
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.AR99, key: "ar99"},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
          {deviceModel: DeviceTypes.NIMO, key: "nimo"},
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
      <ScrollView className="-mx-6 px-6 pt-6">
        <View className="flex-col gap-4 pb-8">
          {glassesOptions
            .filter((glasses) => !SUPER_MODE_ONLY_MODELS.has(glasses.deviceModel) || superMode)
            .map((glasses) => (
              <TouchableOpacity key={glasses.key} onPress={() => triggerGlassesPairingGuide(glasses.deviceModel)}>
                <GlassView className="bg-primary-foreground flex-col items-center justify-center p-6 rounded-2xl overflow-hidden">
                  <View className="flex-row gap-4">
                    <View className="flex-col flex-1 justify-center">
                      <View className="justify-center min-h-6">{getManufacturerLogo(glasses.deviceModel)}</View>
                      <Text
                        className="text-2xl text-foreground font-medium"
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        text={getDisplayName(glasses.deviceModel)}
                      />
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

