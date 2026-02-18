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
  const glassesOptions =
    Platform.OS === "ios"
      ? [
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          devMode && {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
          //{deviceModel: "Brilliant Labs Frame", key: "frame"},
        ]
      : [
          // Android:
          // {deviceModel: DeviceTypes.SIMULATED, key: DeviceTypes.SIMULATED},
          {deviceModel: DeviceTypes.G1, key: "evenrealities_g1"},
          {deviceModel: DeviceTypes.LIVE, key: "mentra_live"},
          {deviceModel: DeviceTypes.MACH1, key: "mentra_mach1"},
          {deviceModel: DeviceTypes.Z100, key: "vuzix-z100"},
          devMode && {deviceModel: DeviceTypes.NEX, key: "mentra_nex"},
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
      <ScrollView style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}>
        <View style={{flexDirection: "column", gap: theme.spacing.s4}}>
          {glassesOptions.map((glasses) => (
            <TouchableOpacity
              key={glasses.key}
              style={themed($settingItem)}
              onPress={() => triggerGlassesPairingGuide(glasses.deviceModel)}>
              <View style={themed($cardContent)}>
                <View style={themed($manufacturerLogo)}>{getManufacturerLogo(glasses.deviceModel)}</View>
                <Image source={getGlassesImage(glasses.deviceModel)} style={themed($glassesImage)} />
                <Text style={[themed($label)]}>{glasses.deviceModel}</Text>
              </View>
            </TouchableOpacity>
          ))}
          <Spacer height={theme.spacing.s4} />
        </View>
      </ScrollView>
    </Screen>
  )
}

const $settingItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: 190,
  borderRadius: spacing.s4,
  backgroundColor: colors.primary_foreground,
  overflow: "hidden",
})

const $cardContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: spacing.s3,
  width: "100%",
})

const $manufacturerLogo: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  justifyContent: "center",
  minHeight: 24,
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  width: 180,
  maxHeight: 80,
  resizeMode: "contain",
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s4,
  fontWeight: "600",
  flexWrap: "wrap",
  color: colors.text,
})
