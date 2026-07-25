import {SETTINGS, useSetting} from "@mentra/engine"
import {LinearGradient} from "expo-linear-gradient"
import {useCallback, useMemo} from "react"
import {Linking, Pressable, View, ViewStyle} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Screen, Text} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

const LEGACY_MENTRAOS_URL = "https://mentraglass.com/legacy"

const $legacyHero: ViewStyle = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 24,
  overflow: "hidden",
  paddingHorizontal: 28,
}

export default function MentraOSOnboarding() {
  const pushPrevious = usePushPrevious()
  const {theme} = useAppTheme()
  const [, setOnboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)

  const openLegacyPage = useCallback(() => {
    void Linking.openURL(LEGACY_MENTRAOS_URL).catch((error) => {
      console.error("Failed to open the MentraOS Legacy page", error)
    })
  }, [])

  const steps = useMemo<OnboardingStep[]>(
    () => [
      {
        type: "image",
        name: "Welcome to Mentra",
        transition: true,
        duration: 500,
        title: translate("onboarding:osWelcomeTitle"),
        subtitle: translate("onboarding:osWelcomeSubtitle"),
        titleCentered: true,
        subtitleCentered: true,
        content: (
          <View className="flex-1 items-center justify-center" testID="mentraos-onboarding-welcome-logo">
            <MentraLogoStandalone width={118} height={64} />
          </View>
        ),
      },
      {
        type: "image",
        source: require("@assets/onboarding/os/figma/start-miniapp.png"),
        name: "Start using a miniapp",
        transition: false,
        testID: "mentraos-onboarding-hero-1",
        title: translate("onboarding:osStartMiniappTitle"),
        compactHeader: true,
        compactBody: true,
        details: [
          {
            title: translate("onboarding:osTapToLaunchTitle"),
            description: translate("onboarding:osTapToLaunchDescription"),
          },
        ],
      },
      {
        type: "image",
        source: require("@assets/onboarding/os/figma/minimize-close.png"),
        name: "Minimize or close",
        transition: false,
        testID: "mentraos-onboarding-hero-2",
        title: translate("onboarding:osMinimizeCloseTitle"),
        compactHeader: true,
        compactBody: true,
        details: [
          {
            title: translate("onboarding:osMinimizeTitle"),
            description: translate("onboarding:osMinimizeDescription"),
          },
          {
            title: translate("onboarding:osExitTitle"),
            description: translate("onboarding:osExitDescription"),
          },
        ],
      },
      {
        type: "image",
        source: require("@assets/onboarding/os/figma/running-miniapps.png"),
        name: "Switch between miniapps",
        transition: false,
        testID: "mentraos-onboarding-hero-3",
        title: translate("onboarding:osSwitchMiniappsTitle"),
        compactHeader: true,
        compactBody: true,
        details: [
          {
            title: translate("onboarding:osRunningMiniappsTitle"),
            description: translate("onboarding:osRunningMiniappsDescription"),
          },
          {
            title: translate("onboarding:osExpandTrayTitle"),
            description: translate("onboarding:osExpandTrayDescription"),
          },
        ],
      },
      {
        type: "image",
        source: require("@assets/onboarding/os/figma/miniapp-drawer.png"),
        name: "The miniapp drawer",
        transition: false,
        testID: "mentraos-onboarding-hero-4",
        title: translate("onboarding:osMiniappDrawerTitle"),
        compactHeader: true,
        compactBody: true,
        details: [
          {
            title: translate("onboarding:osTapGridTitle"),
            description: translate("onboarding:osTapGridDescription"),
          },
          {
            title: translate("onboarding:osSearchTitle"),
            description: translate("onboarding:osSearchDescription"),
          },
        ],
      },
      {
        type: "image",
        name: "MentraOS Legacy",
        transition: false,
        testID: "mentraos-onboarding-hero-5",
        title: translate("onboarding:osMovedMiniappsTitle"),
        compactHeader: true,
        compactBody: true,
        content: (
          <LinearGradient
            colors={["#EEF4E3", "#D9E8C4"]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={$legacyHero}
            testID="mentraos-onboarding-hero-5">
            <View className="mb-5 h-20 w-20 items-center justify-center rounded-full bg-white/70">
              <MentraLogoStandalone width={52} height={28} colorOverride="#00B869" />
            </View>
            <Pressable
              accessibilityLabel="Open MentraOS Legacy"
              accessibilityRole="link"
              className="w-full flex-row items-center rounded-2xl border border-border bg-card px-4 py-3"
              onPress={openLegacyPage}
              style={({pressed}) => ({opacity: pressed ? 0.7 : 1})}
              testID="mentraos-onboarding-open-legacy">
              <View className="flex-1">
                <Text className="text-base font-semibold text-card-foreground" text="MentraOS Legacy" />
                <Text className="text-sm text-muted-foreground" text="mentraglass.com/legacy" />
              </View>
              <Icon color={theme.colors.primary} name="external-link" size={24} />
            </Pressable>
          </LinearGradient>
        ),
        details: [
          {
            title: translate("onboarding:osMissingMiniappTitle"),
            description: translate("onboarding:osMissingMiniappDescription"),
          },
          {
            title: translate("onboarding:osMentraOsLegacyTitle"),
            description: translate("onboarding:osMentraOsLegacyDescription"),
          },
        ],
      },
    ],
    [openLegacyPage, theme.colors.primary],
  )

  const finishOnboarding = () => {
    setOnboardingOsCompleted(true)
    pushPrevious()
  }

  const handleCloseButton = () => {
    showAlert(translate("onboarding:osEndOnboardingTitle"), translate("onboarding:osEndOnboardingMessage"), [
      {text: translate("common:no"), onPress: () => {}},
      {
        text: translate("onboarding:confirmSkip"),
        onPress: finishOnboarding,
      },
    ])
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <OnboardingGuide
        steps={steps}
        autoStart={false}
        showCloseButton={true}
        preventBack={true}
        skipFn={handleCloseButton}
        endButtonFn={finishOnboarding}
        startButtonText={translate("onboarding:continueOnboarding")}
        endButtonText={translate("common:continue")}
      />
    </Screen>
  )
}
