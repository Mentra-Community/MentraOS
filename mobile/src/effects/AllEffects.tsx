import {ButtonActions} from "@/effects/ButtonActions"
import {GalleryModeSync} from "@/effects/GalleryModeSync"
import {MtkUpdateAlert} from "@/effects/MtkUpdateAlert"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {Reconnect} from "@/effects/Reconnect"
import {ConsoleLogger} from "@/utils/debug/console"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {BtClassicPairing} from "@/effects/BtClassicPairing"
import {LocalMiniApps} from "@/effects/LocalMiniApps"
import {MpCliAppManager} from "@/components/apps/MpCliAppManager"

export const AllEffects = () => {
  console.log('[AllEffects] Rendering...');
  return (
    <>
      <Reconnect />
      <BtClassicPairing />
      <LocalMiniApps />
      <MpCliAppManager />
      <MtkUpdateAlert />
      <OtaUpdateChecker />
      <NetworkMonitoring />
      <ButtonActions />
      <GalleryModeSync />
      <ConsoleLogger />
    </>
  )
}
