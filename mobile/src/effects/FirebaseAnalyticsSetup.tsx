import {SETTINGS, useSetting} from "@mentra/engine"
import {useEffect} from "react"

import {useDeployment} from "@/services/deployment"
import {disableAnalytics, initAnalytics} from "@/utils/analytics"

export const FirebaseAnalyticsSetup = () => {
  const {activeDeployment, selectionResolved} = useDeployment()
  const [telemetryOptIn] = useSetting<boolean>(SETTINGS.telemetry_enabled.key)
  const [chinaDeployment] = useSetting<boolean>(SETTINGS.china_deployment.key)
  const telemetryEnabled =
    selectionResolved && activeDeployment.manifest.telemetry && telemetryOptIn && !chinaDeployment

  useEffect(() => {
    const updateCollection = telemetryEnabled ? initAnalytics : disableAnalytics
    updateCollection().catch((err) => console.warn("Firebase Analytics configuration failed:", err))
  }, [telemetryEnabled])

  return null
}
