import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import CoreModule, {TouchEvent} from "core"
import {Platform} from "react-native"

const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentra-live/light"

export default function MentraLiveOnboarding() {
  const {clearHistoryAndGoHome} = useNavigationHistory()
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
      fadeOut: true,
      title: translate("onboarding:liveWelcomeTitle"),
      subtitle: translate("onboarding:liveWelcomeSubtitle"),
      titleCentered: true,
      subtitleCentered: true,
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB4_action_button_click.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB4_action_button_click.jpg"),
      name: "Action Button Click",
      playCount: -1, //2,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:liveTakeAPhoto"),
      subtitle: translate("onboarding:livePressActionButton"),
      info: translate("onboarding:liveLedFlashWarning"),
      // wait for the action button to be pressed:
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("button_press", (data: any) => {
            if (data?.type === "button_press" && data?.pressType === "short") {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB5_action_button_record.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB5_action_button_record.jpg"),
      name: "Action Button Record",
      playCount: -1, // 2,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:liveStartRecording"),
      subtitle: translate("onboarding:livePressAndHold"),
      info: translate("onboarding:liveLedFlashWarning"),
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("button_press", (data: any) => {
            if (data?.type === "button_press" && (data?.pressType === "long" || data?.pressType === "short")) {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB5_action_button_record.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB5_action_button_record.jpg"),
      name: "Action Button Stop Recording",
      playCount: -1, // 2,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:liveStopRecording"),
      subtitle: translate("onboarding:livePressAndHoldAgain"),
      info: translate("onboarding:liveLedFlashWarning"),
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("button_press", (data: any) => {
            if (data?.type === "button_press" && (data?.pressType === "long" || data?.pressType === "short")) {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB6_transition_trackpad.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB6_transition_trackpad.jpg"),
      name: "Transition Trackpad",
      playCount: -1, // 1,
      transition: true,
      fadeOut: true,
      // show next slide's title and subtitle:
      title: translate("onboarding:livePlayMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB7_trackpad_tap.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB7_trackpad_tap.jpg"),
      name: "Trackpad Tap",
      playCount: -1, // 1,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:livePlayMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("touch_event", (data: TouchEvent) => {
            if (data?.gesture_name === "double_tap") {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB8_trackpad_slide.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB8_trackpad_slide.jpg"),
      name: "Trackpad Volume Slide",
      playCount: -1, // 1,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:liveAdjustVolume"),
      subtitle: translate("onboarding:liveSwipeTouchpadUp") + "\n" + translate("onboarding:liveSwipeTouchpadDown"),
      // subtitle2: translate("onboarding:liveSwipeTouchpadDown"),
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("touch_event", (data: TouchEvent) => {
            if (data?.gesture_name === "forward_swipe" || data?.gesture_name === "backward_swipe") {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB9_trackpad_pause.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB9_trackpad_pause.jpg"),
      name: "Trackpad Pause",
      playCount: -1, // 1,
      transition: false,
      fadeOut: true,
      title: translate("onboarding:livePauseMusic"),
      subtitle: translate("onboarding:liveDoubleTapTouchpad"),
      waitFn: (): Promise<void> => {
        return new Promise<void>((resolve) => {
          const unsub = CoreModule.addListener("touch_event", (data: TouchEvent) => {
            if (data?.gesture_name === "double_tap") {
              unsub.remove()
              resolve()
            }
          })
        })
      },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB10_cord.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB10_cord.jpg"),
      name: "Cord",
      playCount: 1,
      transition: true,
      // fadeOut: true,
      title: " ",
      // title: translate("onboarding:liveConnectCable"),
      // subtitle: translate("onboarding:liveCableDescription"),
      // info: translate("onboarding:liveCableInfo"),
      replayable: false,
      buttonTimeoutMs: 5000,
      // waitFn: (): Promise<void> => {
      //   return new Promise<void>((resolve) => {
      //     // Check if already charging
      //     if (useGlassesStore.getState().charging) {
      //       resolve()
      //       return
      //     }
      //     // Wait for charging state to become true
      //     const unsub = useGlassesStore.subscribe(
      //       (state) => state.charging,
      //       (charging) => {
      //         if (charging) {
      //           unsub()
      //           resolve()
      //         }
      //       },
      //     )
      //   })
      // },
    },
    {
      type: "video",
      source: `${CDN_BASE}/ONB11_end.mp4`,
      poster: require("@assets/onboarding/live/thumbnails/ONB11_end.jpg"),
      name: "End",
      playCount: 1,
      transition: false,
      replayable: false,
      title: translate("onboarding:liveEndTitle"),
      subtitle: translate("onboarding:liveEndMessage"),
      titleCentered: true,
      subtitleCentered: true,
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

  const handleCloseButton = () => {
    showAlert(translate("onboarding:liveEndOnboardingTitle"), translate("onboarding:liveEndOnboardingMessage"), [
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
    clearHistoryAndGoHome()
  }

  const handleEndButton = () => {
    setOnboardingLiveCompleted(true)
    clearHistoryAndGoHome()
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      <OnboardingGuide
        steps={steps}
        autoStart={false}
        showCloseButton={true}
        preventBack={true}
        requiresGlassesConnection={true}
        skipFn={handleCloseButton}
        endButtonFn={handleEndButton}
        startButtonText={translate("onboarding:continueOnboarding")}
        endButtonText={translate("common:continue")}
      />
    </Screen>
  )
}
