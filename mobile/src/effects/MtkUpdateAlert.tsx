import {useEffect} from "react"

import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

/**
 * Effect that listens for MTK firmware update completion.
 *
 * Note: The OTA progress screen now handles the mtk_update_complete event
 * and transitions from "installing" to "completed" state.
 * This effect is kept for logging purposes but no longer shows an alert
 * to avoid duplicate notifications when the OTA screen is active.
 */
export function MtkUpdateAlert() {
  useEffect(() => {
    const handleMtkUpdateComplete = (data: {message: string; timestamp: number}) => {
      console.log("MTK firmware update complete:", data.message)
      // Alert removed - OTA progress screen handles the UI transition
    }

    // Subscribe to MTK update complete events
    GlobalEventEmitter.on("mtk_update_complete", handleMtkUpdateComplete)

    // Cleanup subscription on unmount
    return () => {
      GlobalEventEmitter.off("mtk_update_complete", handleMtkUpdateComplete)
    }
  }, [])

  return null
}
