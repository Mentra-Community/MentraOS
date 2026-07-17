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
import {AR99_MODEL_OPTIONS, type Ar99ProjectName, getGlassesImage} from "@/utils/getGlassesImage"
import GlassView from "@/components/ui/GlassView"

const AR99_LOGO = require("../../../assets/logo/ar99_logo.png")
const HOLOVOX_LOGO = require("../../../assets/logo/holovox_log.png")

type GlassesOption = {
  key: string
  deviceModel: string
  projectName?: Ar99ProjectName
  manufacturerName?: string
  displayName?: string
  imageSource?: any
}

export default function SelectGlassesModelScreen() {
  const {theme} = useAppTheme()
  const {push, goBack} = useNavigationStore.getState()
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  const getTitleLogoSource = (option: GlassesOption) => {
    const normalizedProjectName = option.projectName?.trim().toUpperCase()
    if (normalizedProjectName === "AR99" || normalizedProjectName === "AF99") {
      return AR99_LOGO
    }
    if (normalizedProjectName === "HVXM" || normalizedProjectName === "HVXF") {
      return HOLOVOX_LOGO
    }
    return null
  }

  const getManufacturerLogo = (option: GlassesOption) => {
    const titleLogoSource = getTitleLogoSource(option)
    if (option.manufacturerName) {
      if (titleLogoSource) {
        return (
          <View className="flex-row items-center gap-2">
            <Image source={titleLogoSource} className="h-5 w-5" resizeMode="contain" />
            <Text text={option.manufacturerName} className="text-foreground font-semibold text-lg" />
          </View>
        )
      }
      return <Text text={option.manufacturerName} className="text-foreground font-semibold text-lg" />
    }

    switch (option.deviceModel) {
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
      default:
        return null
    }
  }

  const getDisplayName = (option: GlassesOption) => option.displayName ?? option.deviceModel
  const getImageSource = (option: GlassesOption) => option.imageSource ?? getGlassesImage(option.deviceModel)

  const SUPER_MODE_ONLY_MODELS = new Set<string>([DeviceTypes.NEX, DeviceTypes.NIMO])

  const defaultAr99Option = AR99_MODEL_OPTIONS.find((option) => option.projectName === "AR99")
  const ar99Options: GlassesOption[] = defaultAr99Option
    ? [
        {
          key: defaultAr99Option.key,
          deviceModel: defaultAr99Option.deviceModel,
          projectName: defaultAr99Option.projectName,
          manufacturerName: defaultAr99Option.manufacturerName,
          displayName: defaultAr99Option.displayName,
          imageSource: defaultAr99Option.imageSource,
        },
      ]
    : []

  const sharedOptions: GlassesOption[] = [
    ...ar99Options,
    {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
    {deviceModel: DeviceTypes.G2, key: "evenrealities_g2"},
    {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
    {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
    {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
    {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
    {deviceModel: DeviceTypes.NIMO, key: "nimo"},
  ]

  const glassesOptions = Platform.OS === "ios" ? sharedOptions : sharedOptions

  const triggerGlassesPairingGuide = async (option: GlassesOption) => {
    push("/pairing/prep", {
      deviceModel: option.deviceModel,
      ar99ProjectName: option.deviceModel === DeviceTypes.AR99 ? undefined : option.projectName,
    })
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
              <TouchableOpacity key={glasses.key} onPress={() => triggerGlassesPairingGuide(glasses)}>
                <GlassView className="bg-primary-foreground flex-col items-center justify-center p-6 rounded-2xl overflow-hidden">
                  <View className="flex-row gap-4">
                    <View className="flex-col flex-1 justify-center">
                      {getManufacturerLogo(glasses) ? (
                        <View className="justify-center min-h-6">{getManufacturerLogo(glasses)}</View>
                      ) : null}
                      <Text
                        className="text-2xl text-foreground font-medium"
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        text={getDisplayName(glasses)}
                      />
                    </View>
                    <Image source={getImageSource(glasses)} className="w-[90px] max-h-[80px] object-contain" />
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

