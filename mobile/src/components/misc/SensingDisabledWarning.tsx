// SensingDisabledWarning.tsx
import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"

import {Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

const SensingDisabledWarning: React.FC = () => {
  const {push} = useNavigationHistory()
  const {theme, themed} = useAppTheme()
  const [sensingEnabled, _setSensingEnabled] = useSetting(SETTINGS.sensing_enabled.key)

  if (sensingEnabled) {
    return null
  }

  return (
    <View
      style={[themed($container), {backgroundColor: theme.colors.backgroundAlt, borderColor: theme.colors.warning}]}>
      <View style={themed($warningContent)}>
        <Icon name="microphone-off" size={22} color="#FF9800" />
        <Text style={themed($warningText)}>{translate("warning:sensingDisabled")}</Text>
      </View>
      <TouchableOpacity
        style={themed($settingsButton)}
        onPress={() => {
          push("/settings/privacy")
        }}>
        <Text style={themed($settingsButtonTextBlue)} tx="common:settings" />
      </TouchableOpacity>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  padding: spacing.s4,
  borderRadius: spacing.s4,
  borderWidth: spacing.s0_5,
  alignSelf: "center",
})

const $settingsButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s2,
})

const $settingsButtonTextBlue: ThemedStyle<TextStyle> = ({spacing, colors}) => ({
  color: colors.primary,
  fontSize: spacing.s4,
  fontWeight: "bold",
})

const $warningContent: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flexDirection: "row",
  flex: 1,
})

const $warningText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.warning,
  flex: 1,
  fontSize: 14,
  marginLeft: spacing.s3,
})

export default SensingDisabledWarning
