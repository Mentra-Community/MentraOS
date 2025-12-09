import {Appearance} from "react-native"

import {SETTINGS, useSettingsStore} from "@/stores/settings"

export const getCurrentTheme = async (): Promise<"light" | "dark"> => {
  const theme = await useSettingsStore.getState().getSetting(SETTINGS.theme_preference.key)
  if (theme === "system") {
    return Appearance.getColorScheme() === "dark" ? "dark" : "light"
  }
  if (theme === "light" || theme === "dark") {
    return theme as "light" | "dark"
  }
  return "light"
}

export const getThemeIsDark = async (): Promise<boolean> => {
  const theme = await getCurrentTheme()
  return theme === "dark"
}
