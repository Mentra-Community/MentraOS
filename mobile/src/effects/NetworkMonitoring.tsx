import {useEffect} from "react"

import {useGlassesStore} from "@/stores/glasses"
import {asgCameraApi} from "@/services/asg/asgCameraApi"

export function NetworkMonitoring() {
  const hotspotGatewayIp = useGlassesStore((state) => state.hotspotGatewayIp)
  useEffect(() => {
    asgCameraApi.setServer(hotspotGatewayIp, 8089)
  }, [hotspotGatewayIp])

  return null
}
