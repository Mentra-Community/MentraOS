import { useEffect, useState } from "react"
import { Slot, SplashScreen } from "expo-router"

import { useFonts } from "@expo-google-fonts/space-grotesk"
import { colors, customFontsToLoad } from "@/theme"
import { initI18n } from "@/i18n"
import { loadDateFnsLocale } from "@/utils/formatDate"
import { useThemeProvider } from "@/utils/useAppTheme"
import { AllProviders } from "@/utils/AllProviders"
import BackgroundGradient from "@/components/misc/BackgroundGradient"
import Toast, { SuccessToast, BaseToast, ErrorToast } from 'react-native-toast-message';
import { View } from "react-native";
import { Text } from "@/components/ignite";
import { Ionicons } from '@expo/vector-icons'; // Replace with your project's icon import if different

SplashScreen.preventAutoHideAsync()

if (__DEV__) {
  // Load Reactotron configuration in development. We don't want to
  // include this in our production bundle, so we are using `if (__DEV__)`
  // to only execute this in development.
  require("src/devtools/ReactotronConfig.ts")
}

export { ErrorBoundary } from "@/components/ErrorBoundary/ErrorBoundary"

export default function Root() {
  const [fontsLoaded, fontError] = useFonts(customFontsToLoad)
  const [isI18nInitialized, setIsI18nInitialized] = useState(false)
  const { themeScheme, setThemeContextOverride, ThemeProvider } = useThemeProvider()

  useEffect(() => {
    initI18n()
      .then(() => setIsI18nInitialized(true))
      .then(() => loadDateFnsLocale())
  }, [])

  const loaded = fontsLoaded && isI18nInitialized

  const toastConfig = {
    baseToast: ({ text1, props }: { text1?: string; props?: { icon?: React.ReactNode } }) => (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.background,
          borderRadius: 16,
          paddingVertical: 12,
          paddingHorizontal: 16,
          marginHorizontal: 16,
        }}
      >
        {props?.icon && (
          <View style={{ marginRight: 10, justifyContent: "center", alignItems: "center" }}>
            {props.icon}
          </View>
        )}
        <Text
          text={text1}
          style={{
            fontSize: 15,
            color: colors.text,
          }}
        />
      </View>
    )
  }

  useEffect(() => {
    if (fontError) throw fontError
  }, [fontError])

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync()
    }
  }, [loaded])

  if (!loaded) {
    return null
  }

  return (
    <ThemeProvider value={{ themeScheme, setThemeContextOverride }}>
      <AllProviders>
        <View style={{ flex: 1 }}>
          <BackgroundGradient>
            <Slot />
            <Toast config={toastConfig} />
          </BackgroundGradient>
        </View>
      </AllProviders>
    </ThemeProvider>
  )
}
