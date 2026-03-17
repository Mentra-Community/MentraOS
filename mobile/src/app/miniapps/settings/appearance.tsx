import {Platform, ScrollView} from "react-native"
import {isLiquidGlassAvailable} from "expo-glass-effect"

import {Screen, Header} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import BackgroundPicker from "@/components/settings/BackgroundPicker"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {type ThemeType} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {translate} from "@/i18n"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {OptionList} from "@/components/ui/Options"

export default function AppearanceSettingsPage() {
  const {goBack} = useNavigationHistory()

  const [themePreference, setThemePreference] = useSetting(SETTINGS.theme_preference.key)
  const [iosGlassEffect, setIosGlassEffect] = useSetting(SETTINGS.ios_glass_effect.key)
  const [appSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)
  const [androidBlur, setAndroidBlur] = useSetting(SETTINGS.android_blur.key)

  const showGlassToggle = appSwitcherUi && Platform.OS === "ios" && isLiquidGlassAvailable()
  const showAndroidBlurToggle = appSwitcherUi && Platform.OS === "android"

  const handleThemeChange = async (newTheme: ThemeType) => {
    await setThemePreference(newTheme)
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("settings:appearance")} leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView className="pt-6" contentContainerClassName="gap-6">
        <OptionList
          title={translate("appearanceSettings:theme")}
          selected={themePreference}
          onSelect={handleThemeChange}
          options={[
            {key: "light", label: translate("appearanceSettings:lightTheme")},
            {key: "dark", label: translate("appearanceSettings:darkTheme")},
            {key: "system", label: translate("appearanceSettings:systemDefault")},
          ]}
        />

        {appSwitcherUi && <BackgroundPicker />}

        {showGlassToggle && (
          <Group>
            <ToggleSetting
              label={translate("appearanceSettings:liquidGlassEffect")}
              onValueChange={(value) => setIosGlassEffect(value)}
              value={iosGlassEffect}
            />
          </Group>
        )}

        {showAndroidBlurToggle && (
          <Group>
            <ToggleSetting
              label={translate("appearanceSettings:androidBlur")}
              onValueChange={(value) => setAndroidBlur(value)}
              value={androidBlur}
            />
          </Group>
        )}
      </ScrollView>
    </Screen>
  )
}