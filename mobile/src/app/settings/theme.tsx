import {View, TouchableOpacity, ViewStyle, TextStyle, ScrollView} from "react-native"

import {Screen, Header, Text, Icon} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {type ThemeType} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"

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
      {themePreference === themeKey ? (
        <Icon name="check" size={24} color={theme.colors.primary} />
      ) : (
        <Icon name="check" size={24} color={theme.colors.primary_foreground} />
      )}
    </TouchableOpacity>
  )

  return (
    <Screen preset="fixed">
      <Header title="Theme Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView className="pt-6">
        <Group>
          {renderThemeOption("light", "Light Theme", undefined)}
          {renderThemeOption("dark", "Dark Theme", undefined)}
          {renderThemeOption("system", "System Default", undefined)}
        </Group>
      </ScrollView>
    </Screen>
  )
}

const $settingsItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  paddingVertical: spacing.s5,
  paddingHorizontal: spacing.s6,
  backgroundColor: colors.primary_foreground,
  alignItems: "center",
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.s3,
})
