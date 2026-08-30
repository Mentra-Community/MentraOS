import {useEffect} from "react"

import {useDeployment} from "@/services/deployment"
import {disableAnalytics, initAnalytics} from "@/utils/analytics"

export const FirebaseAnalyticsSetup = () => {
  const {activeDeployment} = useDeployment()
  const telemetryEnabled = activeDeployment.kind === "consumer" || activeDeployment.manifest.telemetry

  useEffect(() => {
    const updateCollection = telemetryEnabled ? initAnalytics : disableAnalytics
    updateCollection().catch((err) => console.warn("Firebase Analytics configuration failed:", err))
  }, [telemetryEnabled])

  return null
}
