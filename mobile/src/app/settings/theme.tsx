import {MaterialCommunityIcons} from "@expo/vector-icons"
import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Screen, Header, Text} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {type ThemeType} from "@/utils/useAppTheme"

export default function ThemeSettingsPage() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()

  const [themePreference, setThemePreference] = useSetting(SETTINGS.theme_preference.key)

  const handleThemeChange = async (newTheme: ThemeType) => {
    await setThemePreference(newTheme)
  }

  const renderThemeOption = (themeKey: ThemeType, label: string, subtitle?: string, style?: ViewStyle) => (
    <TouchableOpacity style={[themed($settingsItem), style]} onPress={() => handleThemeChange(themeKey)}>
      <View style={{flexDirection: "column", gap: 4}}>
        <Text text={label} style={{color: theme.colors.text}} />
        {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
      </View>
      {themePreference === themeKey && <MaterialCommunityIcons name="check" size={24} color={theme.colors.primary} />}
    </TouchableOpacity>
  )

  return (
    <Screen preset="scroll" style={themed($styles.screen)}>
      <Header title="Theme Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <Group style={{marginTop: theme.spacing.s8}}>
        {renderThemeOption("light", "Light Theme", undefined)}
        {renderThemeOption("dark", "Dark Theme", undefined)}
        {renderThemeOption("system", "System Default", undefined)}
      </Group>
    </Screen>
  )
}

const $settingsItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  paddingVertical: spacing.s5,
  paddingHorizontal: spacing.s6,
  backgroundColor: colors.primary_foreground,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.s3,
})
