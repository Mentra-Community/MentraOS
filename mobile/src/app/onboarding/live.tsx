import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"

export const unstable_settings = {
  options: {
    gestureEnabled: false,
  },
}

// NOTE: you can't have 2 transition videos in a row or things will break:
const steps: OnboardingStep[] = [
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB0_start_onboarding.mp4"),
    name: "Start Onboarding",
    playCount: 1,
    transition: true,
    title: " ", // for spacing so it's consistent with the other steps
    // title: "Welcome to Mentra Live",
    // info: "Learn the basics",
  },
  // {
  //   type: "video",
  //   source: require("@assets/onboarding/live/ONB1_power_button.mp4"),
  //   name: "Power Button",
  //   loop: true,
  //   transition: false,
  // },
  // {
  //   type: "video",
  //   source: require("@assets/onboarding/live/ONB2_pairing_successful.mp4"),
  //   name: "Pairing Successful",
  //   loop: false,
  //   transition: false,
  // },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB4_action_button_click.mp4"),
    name: "Action Button Click",
    playCount: 2,
    transition: false,
    title: translate("onboarding:liveTakeAPhoto"),
    subtitle: translate("onboarding:livePressActionButton"),
    info: translate("onboarding:liveLedFlashWarning"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB5_action_button_record.mp4"),
    name: "Action Button Record",
    playCount: 2,
    transition: false,
    title: translate("onboarding:liveStartRecording"),
    subtitle: translate("onboarding:livePressAndHold"),
    info: translate("onboarding:liveLedFlashWarning"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB5_action_button_record.mp4"),
    name: "Action Button Stop Recording",
    playCount: 2,
    transition: false,
    title: translate("onboarding:liveStopRecording"),
    subtitle: translate("onboarding:livePressAndHoldAgain"),
    info: translate("onboarding:liveLedFlashWarning"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB6_transition_trackpad.mp4"),
    name: "Transition Trackpad",
    playCount: 1,
    transition: true,
    // show next slide's title and subtitle:
    title: translate("onboarding:livePlayMusic"),
    subtitle: translate("onboarding:liveDoubleTapTouchpad"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB7_trackpad_tap.mp4"),
    name: "Trackpad Tap",
    playCount: 1,
    transition: false,
    title: translate("onboarding:livePlayMusic"),
    subtitle: translate("onboarding:liveDoubleTapTouchpad"),
  },
  // {
  //   source: require("@assets/onboarding/live/ONB8_transition_trackpad2.mp4"),
  //   name: "Transition Trackpad 2",
  //   loop: false,
  //   transition: true,
  // },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB8_trackpad_slide.mp4"),
    name: "Trackpad Volume Slide",
    playCount: 1,
    transition: false,
    title: translate("onboarding:liveAdjustVolume"),
    subtitle: translate("onboarding:liveSwipeTouchpadUp"),
    subtitle2: translate("onboarding:liveSwipeTouchpadDown"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB9_trackpad_pause.mp4"),
    name: "Trackpad Pause",
    playCount: 1,
    transition: false,
    title: translate("onboarding:livePauseMusic"),
    subtitle: translate("onboarding:liveDoubleTapTouchpad"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB10_cord.mp4"),
    name: "Cord",
    playCount: 1,
    transition: false,
    title: translate("onboarding:liveConnectCable"),
    subtitle: translate("onboarding:liveCableDescription"),
    info: translate("onboarding:liveCableInfo"),
  },
  {
    type: "video",
    source: require("@assets/onboarding/live/ONB11_end.mp4"),
    name: "End",
    playCount: 1,
    transition: false,
    subtitle: translate("onboarding:liveEndTitle"),
    subtitle2: translate("onboarding:liveEndMessage"),
  },
]

export default function MentraLiveOnboarding() {
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const {clearHistoryAndGoHome, replaceAll} = useNavigationHistory()
  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={false}
        mainTitle={translate("onboarding:liveWelcomeTitle")}
        mainSubtitle={translate("onboarding:liveWelcomeSubtitle")}
        endButtonFn={() => {
          if (onboardingOsCompleted) {
            clearHistoryAndGoHome()
            return
          }
          replaceAll("/onboarding/os")
        }}
        endButtonText={
          onboardingOsCompleted ? translate("onboarding:liveEndTitle") : translate("onboarding:learnAboutOs")
        }
      />
    </Screen>
  )
}
