import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"

// NOTE: you can't have 2 transition videos in a row or things will break:
const steps: OnboardingStep[] = [
  {
    type: "video",
    name: "Start and stop apps",
    source: require("@assets/onboarding/os/start_stop_apps.mov"),
    containerClassName: "bg-background",
    transition: false,
    playCount: 2,
    bullets: [
      translate("onboarding:osStartStopApps"),
      translate("onboarding:osStartStopAppsBullet1"),
      translate("onboarding:osStartStopAppsBullet2"),
    ],
  },
  {
    type: "video",
    name: "Open an app",
    source: require("@assets/onboarding/os/open_an_app.mov"),
    containerClassName: "bg-background",
    transition: false,
    playCount: 2,
    bullets: [
      translate("onboarding:osOpenApp"),
      translate("onboarding:osOpenAppBullet1"),
      translate("onboarding:osOpenAppBullet2"),
    ],
  },
  {
    type: "video",
    name: "Background apps",
    source: require("@assets/onboarding/os/background_apps.mov"),
    containerClassName: "bg-background",
    transition: false,
    playCount: 2,
    bullets: [
      translate("onboarding:osBackgroundApps"),
      translate("onboarding:osBackgroundAppsBullet1"),
      translate("onboarding:osBackgroundAppsBullet2"),
    ],
  },
  // {
  //   type: "video",
  //   name: "Foreground and Background Apps",
  //   source: require("@assets/onboarding/os/foreground_background_apps.mov"),
  //   containerClassName: "bg-background",
  //   transition: false,
  //   playCount: 2,
  //   bullets: [
  //     translate("onboarding:osForegroundAndBackgroundApps"),
  //     translate("onboarding:osForegroundAndBackgroundAppsBullet1"),
  //     translate("onboarding:osForegroundAndBackgroundAppsBullet2"),
  //   ],
  // },
  // {
  //   type: "video",
  //   name: "Mentra AI",
  //   source: require("@assets/onboarding/os/mentra_ai.mov"),
  //   containerClassName: "bg-background",
  //   transition: false,
  //   playCount: 2,
  //   bullets: [
  //     translate("onboarding:osMentraAi"),
  //     translate("onboarding:osMentraAiBullet1"),
  //     translate("onboarding:osMentraAiBullet2"),
  //   ],
  // },
]

export default function MentraOSOnboarding() {
  const {clearHistoryAndGoHome} = useNavigationHistory()
  const [_onboardingOsCompleted, setOnboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showSkipButton={false}
        endButtonFn={() => {
          setOnboardingOsCompleted(true)
          clearHistoryAndGoHome()
        }}
      />
    </Screen>
  )
}
