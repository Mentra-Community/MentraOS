import {SETTINGS, useSetting} from "@mentra/engine"
import {useMemo} from "react"
import {View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

export default function MentraOSOnboarding() {
  const pushPrevious = usePushPrevious()
  const [, setOnboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)

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
    ],
    [],
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
