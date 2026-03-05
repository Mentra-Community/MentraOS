import {ButtonActions} from "@/effects/ButtonActions"
import {GalleryModeSync} from "@/effects/GalleryModeSync"
import {MtkUpdateAlert} from "@/effects/MtkUpdateAlert"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {Reconnect} from "@/effects/Reconnect"
import {ConsoleLogger} from "@/utils/debug/console"
import {FirebaseAnalyticsSetup} from "@/effects/FirebaseAnalyticsSetup"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {BtClassicPairing} from "@/effects/BtClassicPairing"
import Compositor from "@/effects/Compositor"

export const AllEffects = () => {
  return (
    <>
      <Reconnect />
      <BtClassicPairing />
      <Compositor />
      <MtkUpdateAlert />
      <OtaUpdateChecker />
      <NetworkMonitoring />
      <ButtonActions />
      <GalleryModeSync />
      <ConsoleLogger />
      <FirebaseAnalyticsSetup />
    </>
  )
}
