import {useEffect, useState} from "react"
import {Screen} from "@/components/ignite"
import {OnboardingStep} from "@/components/onboarding/OnboardingGuide"
import {translate} from "@/i18n"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import CoreModule from "core"
import {AudioPairingPrompt} from "@/components/pairing/AudioPairingPrompt"
import GlassesTroubleshootingModal from "@/components/misc/GlassesTroubleshootingModal"
import {SETTINGS, useSetting} from "@/stores/settings"

const CDN_BASE = "https://mentra-videos-cdn.mentraglass.com/onboarding/mentra-live/light"

export default function BtClassicPairingScreen() {
  const {pushPrevious} = useNavigationHistory()
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const [deviceName] = useSetting(SETTINGS.device_name.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)

  focusEffectPreventBack()

  const handleSuccess = () => {
    // we should have a device name saved in the core:
    CoreModule.connectByName("")
    pushPrevious()
  }

  useEffect(() => {
    console.log("BTCLASSIC: useEffect()", btcConnected)
    if (btcConnected) {
      handleSuccess()
    }
  }, [btcConnected])

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
  ]

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]}>
      {/* <OnboardingGuide
        steps={steps}
        autoStart={false}
        mainTitle={translate("onboarding:liveWelcomeTitle")}
        mainSubtitle={translate("onboarding:liveWelcomeSubtitle")}
        showCloseButton={false}
        // exitFn={() => {
        //   pushPrevious()
        // }}
        endButtonText={translate("common:continue")}
        endButtonFn={() => {
          console.log("BT_CLASSIC: endButtonFn()")
          // pushPrevious()
        }}
        showSkipButton={false}
        // endButtonText={
        //   onboardingOsCompleted ? translate("onboarding:liveEndTitle") : translate("onboarding:learnAboutOs")
        // }
      /> */}
      <AudioPairingPrompt
        deviceName={deviceName}
        // onSkip={() => {
        //   // Navigate first - don't update state which could cause race conditions
        //   // replace("/pairing/success", {glassesModelName: glassesModelName})
        // }}
      />
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        glassesModelName={defaultWearable}
      />
    </Screen>
  )
}
