import {DeviceTypes, SETTINGS, useSetting} from "@mentra/engine"
import {useRef} from "react"
import {View, TouchableOpacity, Platform, ScrollView, Image} from "react-native"

import {EvenRealitiesLogo} from "@/components/brands/EvenRealitiesLogo"
import {MentraLogo} from "@/components/brands/MentraLogo"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {NimoLogo} from "@/components/brands/NimoLogo"
import {VuzixLogo} from "@/components/brands/VuzixLogo"
import {XingyiLogo} from "@/components/brands/XingyiLogo"
import {Text, Header} from "@/components/ignite"
import {Screen} from "@/components/ignite/Screen"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {AR99_MODEL_OPTIONS, type Ar99ProjectName, getGlassesImage} from "@/utils/getGlassesImage"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"
import GlassView from "@/components/ui/GlassView"
import {deploymentStore} from "@/services/deployment"

type GlassesOption = {
  key: string
  modelId: string
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
  const pairingStartPending = useRef(false)

  const getManufacturerLogo = (option: GlassesOption) => {
    if (option.manufacturerName) {
      if (option.projectName?.trim().toUpperCase() === "AR99") {
        return <XingyiLogo color={theme.colors.text} />
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

  const ar99Options: GlassesOption[] = AR99_MODEL_OPTIONS.map((option) => ({
    key: option.key,
    modelId: `ar99:${option.projectName.toLowerCase()}`,
    deviceModel: option.deviceModel,
    projectName: option.projectName,
    manufacturerName: option.manufacturerName,
    displayName: option.displayName,
    imageSource: option.imageSource,
  }))

  const sharedOptions: GlassesOption[] = [
    {deviceModel: DeviceTypes.LIVE, key: "mentra_live", modelId: "mentra-live"},
    ...ar99Options,
    {deviceModel: DeviceTypes.G1, key: "evenrealities_g1", modelId: "even-realities-g1"},
    {deviceModel: DeviceTypes.G2, key: "evenrealities_g2", modelId: "even-realities-g2"},
    {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1", modelId: "mentra-mach1"},
    {deviceModel: DeviceTypes.Z100, key: "vuzix-z100", modelId: "vuzix-z100"},
    {deviceModel: DeviceTypes.NEX, key: "mentra_nex", modelId: "mentra-display"},
    {deviceModel: DeviceTypes.NIMO, key: "nimo", modelId: "nimo"},
  ]

  const deployment = deploymentStore.getActive()
  const allowedModels = deployment.kind === "workspace" ? deployment.manifest.glasses.allowedModelsOverride : null
  const glassesOptions = (Platform.OS === "ios" ? sharedOptions : sharedOptions).filter(
    (option) => allowedModels === null || allowedModels.includes(option.modelId),
  )

  const triggerGlassesPairingGuide = async (option: GlassesOption) => {
    if (option.deviceModel === DeviceTypes.LIVE) {
      if (pairingStartPending.current) return
      pairingStartPending.current = true
      try {
        const readyToScan = await preparePairingScan(option.deviceModel)
        if (readyToScan) {
          push("/pairing/scan", {deviceModel: option.deviceModel})
        }
      } finally {
        pairingStartPending.current = false
      }
      return
    }

    push("/pairing/prep", {
      deviceModel: option.deviceModel,
      ar99ProjectName: option.projectName,
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
              <TouchableOpacity
                key={glasses.key}
                testID={`pairing-model-${glasses.key}`}
                onPress={() => triggerGlassesPairingGuide(glasses)}>
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
