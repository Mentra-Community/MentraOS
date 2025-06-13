import React, {useState, useEffect} from "react"
import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"
import {Screen, Header, Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {MaterialCommunityIcons} from "@expo/vector-icons"
import {translate} from "@/i18n"
import {saveSetting, loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import {router} from "expo-router"
import { type ThemeType } from "@/utils/useAppTheme"

export default function ThemeSettingsPage() {
  const {theme, themed, setThemeContextOverride} = useAppTheme()
  const [selectedTheme, setSelectedTheme] = useState<ThemeType>("light")

  useEffect(() => {
    // Load saved theme preference
    loadSetting(SETTINGS_KEYS.THEME_PREFERENCE, "light").then(savedTheme => {
      setSelectedTheme(savedTheme as ThemeType)
    })
  }, [])

  const handleThemeChange = async (newTheme: ThemeType) => {
    setSelectedTheme(newTheme)
    await saveSetting(SETTINGS_KEYS.THEME_PREFERENCE, newTheme)

    // Apply theme immediately
    if (newTheme === "system") {
      setThemeContextOverride(undefined)
    } else {
      setThemeContextOverride(newTheme)
    }
  }

  const renderThemeOption = (
    themeKey: ThemeType,
    label: string,
    subtitle?: string,
    isLast: boolean = false,
  ) => (
    <>
      <TouchableOpacity
        style={{flexDirection: "row", justifyContent: "space-between", paddingVertical: 8}}
        onPress={() => handleThemeChange(themeKey)}>
        <View style={{flexDirection: "column", gap: 4}}>
          <Text text={label} style={{color: theme.colors.text}} />
          {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
        </View>
        <MaterialCommunityIcons
          name="check"
          size={24}
          color={selectedTheme === themeKey ? (theme.colors.checkmark || theme.colors.palette.primary300) : "transparent"}
        />
      </TouchableOpacity>
      {!isLast && <View style={{height: 1, backgroundColor: theme.colors.palette.neutral300, marginVertical: 4}} />}
    </>
  )

  return (
    <Screen preset="scroll" style={{paddingHorizontal: 20}}>
      <Header
        title="Theme Settings"
        leftIcon="caretLeft"
        onLeftPress={() => router.replace("/(tabs)/settings")}
      />

      <View style={themed($settingsGroup)}>
        {renderThemeOption("light", "Light Theme", undefined, false)}
        {renderThemeOption("dark", "Dark Theme", undefined, false)}
        {renderThemeOption("system", "System Default", undefined, true)}
      </View>
    </Screen>
  )
}

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: 12,
  marginTop: 16,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.sm,
})
