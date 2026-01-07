import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"

const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentraos/light"

export default function MentraOSOnboarding() {
  const {pushPrevious} = useNavigationHistory()
  const [_onboardingOsCompleted, setOnboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)

  // NOTE: you can't have 2 transition videos in a row or things will break:
  const steps: OnboardingStep[] = [
    {
      type: "video",
      name: "Start and stop apps",
      source: `${CDN_BASE}/start_stop_apps.mov`,
      poster: require("@assets/onboarding/os/thumbnails/start_stop_apps.jpg"),
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
      source: `${CDN_BASE}/open_an_app.mov`,
      poster: require("@assets/onboarding/os/thumbnails/open_an_app.jpg"),
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
      source: `${CDN_BASE}/background_apps.mov`,
      poster: require("@assets/onboarding/os/thumbnails/background_apps.jpg"),
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
    //   source: `${CDN_BASE}/foreground_background_apps.mov`,
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
    //   source: `${CDN_BASE}/mentra_ai.mov`,
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

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={true}
        showSkipButton={false}
        exitFn={() => {
          pushPrevious()
        }}
        endButtonFn={() => {
          setOnboardingOsCompleted(true)
          pushPrevious()
        }}
      />
    </Screen>
  )
}
