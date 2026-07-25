import {SETTINGS, useSetting} from "@mentra/engine"
import {useCallback, useMemo} from "react"
import {Linking, View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Screen, Text} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

const LEGACY_MENTRAOS_URL = "https://mentraglass.com/legacy"

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
        fadeOut: true,
        duration: 500,
        title: translate("onboarding:osWelcomeTitle"),
        subtitle: translate("onboarding:osWelcomeSubtitle"),
        titleCentered: true,
        subtitleCentered: true,
        content: (
          <View className="m-6 flex-1 items-center justify-center rounded-3xl bg-secondary">
            <View className="h-32 w-32 items-center justify-center rounded-full bg-background">
              <MentraLogoStandalone width={92} height={50} />
            </View>
          </View>
        ),
      },
      {
        type: "image",
        source: require("@assets/onboarding/os/figma/start-miniapp.png"),
        name: "Start using a miniapp",
        transition: false,
        fadeOut: true,
        testID: "mentraos-onboarding-hero-1",
        title: translate("onboarding:osStartMiniappTitle"),
        compactHeader: true,
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
        fadeOut: true,
        testID: "mentraos-onboarding-hero-2",
        title: translate("onboarding:osMinimizeCloseTitle"),
        compactHeader: true,
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
        fadeOut: true,
        testID: "mentraos-onboarding-hero-3",
        title: translate("onboarding:osSwitchMiniappsTitle"),
        compactHeader: true,
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
        fadeOut: true,
        testID: "mentraos-onboarding-hero-4",
        title: translate("onboarding:osMiniappDrawerTitle"),
        compactHeader: true,
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
        content: (
          <View
            className="m-6 flex-1 items-center justify-center rounded-3xl bg-secondary px-7"
            testID="mentraos-onboarding-hero-5">
            <View className="mb-6 h-22 w-22 items-center justify-center rounded-full bg-background">
              <Icon color={theme.colors.primary} name="world-download" size={48} />
            </View>
            <View className="w-full flex-row items-center rounded-2xl border border-border bg-card px-4 py-4">
              <View className="flex-1">
                <Text className="text-base font-semibold text-card-foreground" text="MentraOS Legacy" />
                <Text className="text-sm text-muted-foreground" text="mentraglass.com/legacy" />
              </View>
              <Icon color={theme.colors.primary} name="external-link" size={24} />
            </View>
          </View>
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
        action: {
          label: translate("onboarding:osOpenLegacyPage"),
          onPress: openLegacyPage,
          testID: "mentraos-onboarding-open-legacy",
        },
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
