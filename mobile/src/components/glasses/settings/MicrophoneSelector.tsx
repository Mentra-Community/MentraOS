import {Fragment} from "react"
import {View, TouchableOpacity, TextStyle, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {Badge} from "@/components/ui"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"

const MIC_OPTIONS = [
  // auto is rendered by itself since it has the recommended label
  {
    label: translate("microphoneSettings:glasses"),
    value: "glasses",
  },
  {
    label: translate("microphoneSettings:phone"),
    value: "phone",
  },
  {
    label: translate("microphoneSettings:bluetooth"),
    value: "bluetooth",
  },
]

export function MicrophoneSelector() {
  const {theme, themed} = useAppTheme()
  const [preferredMic, setPreferredMic] = useSetting(SETTINGS.preferred_mic.key)

  const setMic = async (val: string) => {
    if (val === "phone") {
      // We're potentially about to enable the mic, so request permission
      const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)
      if (!hasMicPermission) {
        // Permission denied, don't toggle the setting
        console.log("Microphone permission denied, cannot enable phone microphone")
        showAlert(
          "Microphone Permission Required",
          "Microphone permission is required to use the phone microphone feature. Please grant microphone permission in settings.",
          [{text: "OK"}],
          {
            iconName: "microphone",
            iconColor: "#2196F3",
          },
        )
        return
      }
    }

    await setPreferredMic(val)
  }

  return (
    <View style={themed($container)}>
      <Text tx="microphoneSettings:preferredMic" style={[themed($label), {marginBottom: theme.spacing.s3}]} />

      <TouchableOpacity style={themed($itemContainer)} onPress={() => setMic("auto")}>
        <View style={themed($recommendedWrapper)}>
          <Text style={{color: theme.colors.text}}>{translate("microphoneSettings:auto")}</Text>
          <Badge text={translate("deviceSettings:recommended")} />
        </View>
        {preferredMic === "auto" ? (
          <Icon name="check" size={24} color={theme.colors.primary} />
        ) : (
          <Icon name="check" size={24} color={theme.colors.primary_foreground} />
        )}
      </TouchableOpacity>

      {MIC_OPTIONS.map((option: {label: string; value: string}) => (
        <Fragment key={option.value}>
          <View style={themed($separator)} />
          <TouchableOpacity key={option.value} style={themed($itemContainer)} onPress={() => setMic(option.value)}>
            <Text text={option.label} style={themed($itemText)} />
            {preferredMic === option.value ? (
              <Icon name="check" size={24} color={theme.colors.primary} />
            ) : (
              <Icon name="check" size={24} color={theme.colors.primary_foreground} />
            )}
          </TouchableOpacity>
        </Fragment>
      ))}
      {/* 
      <View style={themed($separator)} />

      <TouchableOpacity style={themed($itemContainer)} onPress={() => onMicChange("glasses")}>
        <Text tx="deviceSettings:glassesMic" style={themed($itemText)} />
        {preferredMic === "glasses" && <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />}
      </TouchableOpacity> */}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: spacing.s5,
  paddingHorizontal: spacing.s5,
  borderRadius: spacing.s4,
  gap: spacing.s1,
})

const $itemContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingVertical: spacing.s2,
})

const $itemText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
})

const $recommendedWrapper: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s2,
})

const $separator: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 1,
  backgroundColor: colors.separator,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  fontWeight: "600",
})
