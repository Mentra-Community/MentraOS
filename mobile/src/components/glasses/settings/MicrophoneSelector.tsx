import {MaterialCommunityIcons} from "@expo/vector-icons"
import {Fragment} from "react"
import {View, TouchableOpacity, TextStyle, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {Badge} from "@/components/ui"
import {translate} from "@/i18n/translate"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface MicrophoneSelectorProps {
  preferredMic: string
  onMicChange: (mic: string) => void
}

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

export function MicrophoneSelector({preferredMic, onMicChange}: MicrophoneSelectorProps) {
  const {theme, themed} = useAppTheme()

  return (
    <View style={themed($container)}>
      <Text tx="microphoneSettings:preferredMic" style={[themed($label), {marginBottom: theme.spacing.s3}]} />

      <TouchableOpacity style={themed($itemContainer)} onPress={() => onMicChange("auto")}>
        <View style={themed($recommendedWrapper)}>
          <Text style={{color: theme.colors.text}}>{translate("microphoneSettings:auto")}</Text>
          <Badge text={translate("deviceSettings:recommended")} />
        </View>
        {preferredMic === "auto" && <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />}
      </TouchableOpacity>

      {MIC_OPTIONS.map((option: {label: string; value: string}) => (
        <Fragment key={option.value}>
          <View style={themed($separator)} />
          <TouchableOpacity key={option.value} style={themed($itemContainer)} onPress={() => onMicChange(option.value)}>
            <Text text={option.label} style={themed($itemText)} />
            {preferredMic === option.value && (
              <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />
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
