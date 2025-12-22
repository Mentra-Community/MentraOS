import {ButtonActions} from "@/effects/ButtonActions"
import {GallerySyncEffect} from "@/effects/GallerySyncEffect"
import {ModelDownloadEffect} from "@/effects/ModelDownloadEffect"
import {MtkUpdateAlertEffect} from "@/effects/MtkUpdateAlertEffect"
import {NetworkMonitoring} from "@/effects/NetworkMonitoring"
import {OtaUpdateChecker} from "@/effects/OtaUpdateChecker"
import {Reconnect} from "@/effects/Reconnect"

export const AllEffects = () => {
  return (
    <>
      <Reconnect />
      <OtaUpdateChecker />
      <MtkUpdateAlertEffect />
      <NetworkMonitoring />
      <ButtonActions />
      <GallerySyncEffect />
      <ModelDownloadEffect />
    </>
  )
}
