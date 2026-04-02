import {ButtonActions} from "@/effects/ButtonActions"
import {GalleryModeSync} from "@/effects/GalleryModeSync"
import {MtkUpdateAlert} from "@/effects/MtkUpdateAlert"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {Reconnect} from "@/effects/Reconnect"
import {ConsoleLogger} from "@/utils/dev/console"
import {FirebaseAnalyticsSetup} from "@/effects/FirebaseAnalyticsSetup"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {BtClassicPairing} from "@/effects/BtClassicPairing"
import Compositor from "@/effects/Compositor"
import {ScreenshotFeedbackPrompt} from "@/effects/ScreenshotFeedbackPrompt"
// import TranscriptionsListener from "@/effects/TranscriptionsListener"
// import SherpaTest from "@/effects/SherpaTest"
// import WhisperTest from "@/effects/WhisperTest"
// import SherpaTest from "@/effects/SherpaTest"

export const AllEffects = () => {
  return (
    <>
      <Reconnect />
      <BtClassicPairing />
      <Compositor />
      {/* <WhisperTest /> */}
      {/* <SherpaTest /> */}
      {/* <TranscriptionsListener /> */}
      <MtkUpdateAlert />
      <OtaUpdateChecker />
      <NetworkMonitoring />
      <ButtonActions />
      <GalleryModeSync />
      <ConsoleLogger />
      <FirebaseAnalyticsSetup />
      <ScreenshotFeedbackPrompt />
    </>
  )
}
