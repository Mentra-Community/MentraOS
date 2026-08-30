import {SETTINGS, useSetting} from "@mentra/engine"
import {useMemo} from "react"
import {Platform} from "react-native"

import {Screen} from "@/components/ignite"
import {OnboardingGuide, OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {waitForButtonPress, waitForTouchGesture} from "@/components/onboarding/waitForGlassesEvent"
import {CDN_BASE_URL} from "@/constants/appConfig"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"
import {deploymentStore} from "@/services/deployment"

const CDN_BASE = `${CDN_BASE_URL}/onboarding/mentra-live/light`

export default function MentraLiveOnboarding() {
  const {clearHistoryAndGoHome, replace} = useNavigationStore.getState()
  const [_onboardingLiveCompleted, setOnboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [onboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)
  const useRemoteMedia = deploymentStore.getActive().kind === "consumer"

  // NOTE: you can't have 2 transition videos in a row or things will break:
  // Memoized so each step's `waitFn` keeps a stable identity across re-renders.
  // OnboardingGuide's waitFn effect keys off `step.waitFn`; if these were rebuilt
  // every render the effect would re-subscribe and leak a BLE listener each time,
  // which broke photo/video detection during onboarding.
  const steps: OnboardingStep[] = useMemo(() => {
    let built: OnboardingStep[] = [
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
        waitFn: (signal: AbortSignal): Promise<void> => waitForButtonPress(signal, ["short"]),
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
        waitFn: (signal: AbortSignal): Promise<void> => waitForButtonPress(signal, ["long", "short"]),
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
        waitFn: (signal: AbortSignal): Promise<void> => waitForButtonPress(signal, ["long", "short"]),
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
        waitFn: (signal: AbortSignal): Promise<void> => waitForTouchGesture(signal, ["double_tap"]),
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
        waitFn: (signal: AbortSignal): Promise<void> =>
          waitForTouchGesture(signal, ["forward_swipe", "backward_swipe"]),
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
        waitFn: (signal: AbortSignal): Promise<void> => waitForTouchGesture(signal, ["double_tap"]),
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
      built.splice(4, 1)
    }

    if (!useRemoteMedia) {
      built = built.map((step) => {
        if (step.type !== "video") return step
        const {poster, playCount: _playCount, replayable: _replayable, ...base} = step
        return {...base, type: "image", source: poster}
      })
    }

    return built
  }, [useRemoteMedia])

  // reduce down to 2 steps if __DEV__
  // if (__DEV__) {
  //   steps = steps.slice(0, 2)
  // }

  const continueToNextOnboarding = () => {
    const nextRoute = getNextOnboardingRoute({
      includeMentraLive: false,
      onboardingLiveCompleted: true,
      onboardingOsCompleted,
    })
    if (nextRoute) {
      replace(nextRoute)
      return
    }
    clearHistoryAndGoHome()
  }

  const completeMentraLiveOnboarding = () => {
    setOnboardingLiveCompleted(true)
    continueToNextOnboarding()
  }

  const handleCloseButton = () => {
    const messageKey = onboardingOsCompleted
      ? "onboarding:liveEndOnboardingHomeMessage"
      : "onboarding:liveEndOnboardingMessage"

    showAlert(translate("onboarding:liveEndOnboardingTitle"), translate(messageKey), [
      {text: translate("common:no"), onPress: () => {}},
      {
        text: translate("onboarding:confirmSkip"),
        onPress: completeMentraLiveOnboarding,
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
        requiresGlassesConnection={true}
        skipFn={handleCloseButton}
        endButtonFn={completeMentraLiveOnboarding}
        startButtonText={translate("onboarding:continueOnboarding")}
        endButtonText={translate("common:continue")}
      />
    </Screen>
  )
}
