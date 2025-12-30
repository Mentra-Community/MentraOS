import {useEffect} from "react"

import showAlert from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

/**
 * Effect that listens for MTK firmware update completion
 * and shows an alert to the user instructing them to restart their glasses
 */
export function MtkUpdateAlert() {
  useEffect(() => {
    const handleMtkUpdateComplete = (data: {message: string; timestamp: number}) => {
      console.log("MTK firmware update complete:", data.message)

      showAlert("Firmware Update Complete", data.message, [
        {
          text: "OK",
          style: "default",
        },
      ])
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
