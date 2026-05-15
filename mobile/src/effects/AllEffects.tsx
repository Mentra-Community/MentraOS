import {ButtonActions} from "@/effects/ButtonActions"
import Compositor from "@/effects/Compositor"
import {GalleryModeSync} from "@/effects/GalleryModeSync"
import {MemoryWarningMonitor} from "@/effects/MemoryWarningMonitor"
import {MtkUpdateAlert} from "@/effects/MtkUpdateAlert"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {Reconnect} from "@/effects/Reconnect"
import {ConsoleLogger} from "@/utils/dev/console"
import {FirebaseAnalyticsSetup} from "@/effects/FirebaseAnalyticsSetup"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {BtClassicPairing} from "@/effects/BtClassicPairing"
import {ScreenshotFeedbackPrompt} from "@/effects/ScreenshotFeedbackPrompt"
import NavigationHost from "@/effects/NavigationHost"
import CapsuleMenu from "@/effects/CapsuleMenu"
// import TranscriptionsListener from "@/effects/TranscriptionsListener"
// import SherpaTest from "@/effects/SherpaTest"
// import WhisperTest from "@/effects/WhisperTest"
// import SherpaTest from "@/effects/SherpaTest"

export const AllEffects = () => {
  return (
    <>
      <Reconnect />
      <BtClassicPairing />
      <NavigationHost />
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
      <CapsuleMenu forceShow={false} />
      <Compositor />
      <MemoryWarningMonitor />
    </>
  )
}
