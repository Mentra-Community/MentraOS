/**
 * Cloud Gallery Sync Effect
 * Monitors WiFi state and manages cloud gallery polling
 */

import NetInfo from "@react-native-community/netinfo"
import {useEffect} from "react"

import {cloudGallerySyncService} from "@/services/asg/cloudGallerySyncService"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

export const CloudGallerySync = () => {
  useEffect(() => {
    console.log("[CloudGallerySync] Effect mounted - setting up network monitoring and upload notifications")

    // Subscribe to network state changes
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      const isWifi = state.type === "wifi" && state.isConnected
      const isCellular = state.type === "cellular" && state.isConnected

      console.log(`[CloudGallerySync] Network state changed: type=${state.type}, connected=${state.isConnected}`)

      if (isWifi) {
        // Start polling on WiFi
        console.log("[CloudGallerySync] WiFi connected - starting cloud sync polling")
        cloudGallerySyncService.startPolling()
      } else {
        // Stop polling on cellular or disconnected
        if (isCellular) {
          console.log("[CloudGallerySync] Cellular detected - stopping polling to save data")
        } else {
          console.log("[CloudGallerySync] Network disconnected - stopping polling")
        }
        cloudGallerySyncService.stopPolling()
      }
    })

    // Listen for cloud upload notifications from glasses
    const handleCloudUploadComplete = (data: {filename: string; timestamp: number}) => {
      console.log(`[CloudGallerySync] 📱 Received cloud upload notification: ${data.filename}`)
      // Refresh pending count immediately when glasses uploads a picture
      cloudGallerySyncService.checkPending()
    }

    GlobalEventEmitter.addListener("cloud_upload_complete", handleCloudUploadComplete)

    // Check initial state
    NetInfo.fetch().then((state) => {
      const isWifi = state.type === "wifi" && state.isConnected
      if (isWifi) {
        console.log("[CloudGallerySync] Initial state: WiFi connected - starting polling")
        cloudGallerySyncService.startPolling()
      }
    })

    return () => {
      console.log("[CloudGallerySync] Effect unmounting - cleaning up")
      unsubscribeNetInfo()
      GlobalEventEmitter.removeListener("cloud_upload_complete", handleCloudUploadComplete)
      cloudGallerySyncService.stopPolling()
    }
  }, [])

  return null
}
