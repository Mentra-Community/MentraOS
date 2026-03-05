import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {getGlassesImage} from "@/utils/getGlassesImage"

const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentraos/light"

export default function MentraOSOnboarding() {
  const {pushPrevious} = useNavigationHistory()
  const [_onboardingOsCompleted, setOnboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  // focusEffectPreventBack()

  // NOTE: you can't have 2 transition videos in a row or things will break:
  const steps: OnboardingStep[] = [
    {
      type: "image",
      // source: `${CDN_BASE}/start_stop_apps.mp4`,
      source: require("@assets/onboarding/os/thumbnails/start_stop_apps.jpg"),
      name: "Start Onboarding",
      // playCount: 1,
      transition: true,
      fadeOut: true,
      title: translate("onboarding:osWelcomeTitle"),
      subtitle: translate("onboarding:osWelcomeSubtitle"),
      titleCentered: true,
      subtitleCentered: true,
    },
    {
      type: "video",
      name: "Start and stop apps",
      source: `${CDN_BASE}/start_stop_apps.mp4`,
      poster: require("@assets/onboarding/os/thumbnails/start_stop_apps.jpg"),
      containerClassName: "bg-background",
      transition: false,
      fadeOut: true,
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
      source: `${CDN_BASE}/open_an_app.mp4`,
      poster: require("@assets/onboarding/os/thumbnails/open_an_app.jpg"),
      transition: false,
      fadeOut: true,
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
      source: `${CDN_BASE}/background_apps.mp4`,
      poster: require("@assets/onboarding/os/thumbnails/background_apps.jpg"),
      transition: false,
      fadeOut: true,
      playCount: 2,
      bullets: [
        translate("onboarding:osBackgroundApps"),
        translate("onboarding:osBackgroundAppsBullet1"),
        translate("onboarding:osBackgroundAppsBullet2"),
      ],
    },
    {
      type: "video",
      name: "Foreground and Background Apps",
      source: `${CDN_BASE}/foreground_background_apps.mov`,
      poster: require("@assets/onboarding/os/thumbnails/background_apps.jpg"),
      transition: false,
      fadeOut: true,
      playCount: 2,
      bullets: [
        translate("onboarding:osForegroundAndBackgroundApps"),
        translate("onboarding:osForegroundAndBackgroundAppsBullet1"),
        translate("onboarding:osForegroundAndBackgroundAppsBullet2"),
      ],
    },
    {
      type: "image",
      name: "end",
      source: getGlassesImage(defaultWearable),
      containerClassName: "items-center justify-center px-16",
      transition: false,
      title: translate("onboarding:osEndTitle"),
      subtitle: translate("onboarding:osEndSubtitle"),
      titleCentered: true,
      subtitleCentered: true,
    },
  ]

  const handleCloseButton = () => {
    showAlert(translate("onboarding:osEndOnboardingTitle"), translate("onboarding:osEndOnboardingMessage"), [
      {text: translate("common:no"), onPress: () => {}},
      {
        text: translate("onboarding:confirmSkip"),
        onPress: () => {
          handleExit()
        },
      },
    ])
  }

  const handleExit = () => {
    pushPrevious()
  }

  const handleEndButton = () => {
    setOnboardingOsCompleted(true)
    pushPrevious()
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={false}
        showCloseButton={true}
        preventBack={true}
        skipFn={handleCloseButton}
        endButtonFn={handleEndButton}
        startButtonText={translate("onboarding:continueOnboarding")}
        endButtonText={translate("common:continue")}
      />
    </Screen>
  )
}
