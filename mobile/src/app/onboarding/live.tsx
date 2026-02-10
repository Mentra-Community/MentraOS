import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {Platform} from "react-native"

const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentra-live/light"

export default function MentraLiveOnboarding() {
  const {pushPrevious} = useNavigationHistory()
  const [_onboardingLiveCompleted, setOnboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  // NOTE: you can't have 2 transition videos in a row or things will break:
  let steps: OnboardingStep[] = [
    {
      type: "video",
      source: `${CDN_BASE}/ONB0_start_onboarding.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB0_start_onboarding.jpg"),
      name: "Start Onboarding",
      playCount: 1,
      transition: true,
      title: " ", // for spacing so it's consistent with the other steps
      // title: "Welcome to Mentra Live",
      // info: "Learn the basics",
    },
    // {
    //   type: "video",
    //   source: `${CDN_BASE}/ONB1_power_button.mp4`,
    //   name: "Power Button",
    //   loop: true,
    //   transition: false,
    // },
    // {
    //   type: "video",
    //   source: `${CDN_BASE}/ONB2_pairing_successful.mp4`,
    //   name: "Pairing Successful",
    //   loop: false,
    //   transition: false,
    // },
    {
      type: "video",
      source: `${CDN_BASE}/ONB4_action_button_click.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB4_action_button_click.jpg"),
      name: "Action Button Click",
      playCount: 2,
      transition: false,
      title: translate("onboarding:liveTakeAPhoto"),
      subtitle: translate("onboarding:livePressActionButton"),
      info: translate("onboarding:liveLedFlashWarning"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB5_action_button_record.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB5_action_button_record.jpg"),
      name: "Action Button Record",
      playCount: 2,
      transition: false,
      title: translate("onboarding:liveStartRecording"),
      subtitle: translate("onboarding:livePressAndHold"),
      info: translate("onboarding:liveLedFlashWarning"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB5_action_button_record.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB5_action_button_record.jpg"),
      name: "Action Button Stop Recording",
      playCount: 2,
      transition: false,
      title: translate("onboarding:liveStopRecording"),
      subtitle: translate("onboarding:livePressAndHoldAgain"),
      info: translate("onboarding:liveLedFlashWarning"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB6_transition_trackpad.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB6_transition_trackpad.jpg"),
      name: "Transition Trackpad",
      playCount: 1,
      transition: true,
      // show next slide's title and subtitle:
      title: translate("onboarding:livePlayMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB7_trackpad_tap.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB7_trackpad_tap.jpg"),
      name: "Trackpad Tap",
      playCount: 1,
      transition: false,
      title: translate("onboarding:livePlayMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
    },
    // {
    //   source: `${CDN_BASE}/ONB8_transition_trackpad2.mp4`,
    //   name: "Transition Trackpad 2",
    //   loop: false,
    //   transition: true,
    // },
    {
      type: "video",
      source: `${CDN_BASE}/ONB8_trackpad_slide.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB8_trackpad_slide.jpg"),
      name: "Trackpad Volume Slide",
      playCount: 1,
      transition: false,
      title: translate("onboarding:liveAdjustVolume"),
      subtitle: translate("onboarding:liveSwipeTouchpadUp"),
      subtitle2: translate("onboarding:liveSwipeTouchpadDown"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB9_trackpad_pause.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB9_trackpad_pause.jpg"),
      name: "Trackpad Pause",
      playCount: 1,
      transition: false,
      title: translate("onboarding:livePauseMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB10_cord.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB10_cord.jpg"),
      name: "Cord",
      playCount: 1,
      transition: false,
      title: translate("onboarding:liveConnectCable"),
      subtitle: translate("onboarding:liveCableDescription"),
      info: translate("onboarding:liveCableInfo"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB11_end.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB11_end.jpg"),
      name: "End",
      playCount: 1,
      transition: false,
      subtitle: translate("onboarding:liveEndTitle"),
      subtitle2: translate("onboarding:liveEndMessage"),
      title: " ", // for spacing so it's consistent with the other steps
    },
  ]

  // remove JUST index 4 on android because transitions are broken:
  if (Platform.OS === "android") {
    steps.splice(4, 1)
  }

  // reduce down to 2 steps if __DEV__
  // if (__DEV__) {
  //   steps = steps.slice(0, 2)
  // }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={false}
        showCloseButton={false}
        mainTitle={translate("onboarding:liveWelcomeTitle")}
        mainSubtitle={translate("onboarding:liveWelcomeSubtitle")}
        exitFn={() => {
          pushPrevious()
        }}
        endButtonFn={() => {
          setOnboardingLiveCompleted(true)
          pushPrevious()
        }}
        startButtonText={translate("onboarding:continueOnboarding")}
        endButtonText={translate("common:continue")}
      />
    </Screen>
  )
}
