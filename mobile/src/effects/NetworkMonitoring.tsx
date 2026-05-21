import {useEffect} from "react"

import {useGlassesStore} from "@/stores/glasses"
import {asgCameraApi} from "@/services/asg/asgCameraApi"

export function NetworkMonitoring() {
  const hotspotLocalIp = useGlassesStore((state) =>
    state.hotspot.state === "enabled" ? state.hotspot.localIp : undefined,
  )
  useEffect(() => {
    if (hotspotLocalIp) {
      asgCameraApi.setServer(hotspotLocalIp, 8089)
    }
  }, [hotspotLocalIp])

  return null
}
