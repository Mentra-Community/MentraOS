import {ButtonActions} from "@/effects/ButtonActions"
import {CloudGallerySync} from "@/effects/CloudGallerySync"
import {MtkUpdateAlert} from "@/effects/MtkUpdateAlert"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {Reconnect} from "@/effects/Reconnect"

export const AllEffects = () => {
  return (
    <>
      <Reconnect />
      <OtaUpdateChecker />
      <MtkUpdateAlert />
      <NetworkMonitoring />
      <ButtonActions />
      <CloudGallerySync />
    </>
  )
}
