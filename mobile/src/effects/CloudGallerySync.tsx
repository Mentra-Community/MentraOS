/**
 * Cloud Gallery Sync Effect
 * Monitors WiFi state and manages cloud gallery polling
 * Coordinates with glasses upload to prevent race conditions
 */

import axios from "axios"
import NetInfo from "@react-native-community/netinfo"
import {useEffect} from "react"

import {cloudGallerySyncService} from "@/services/asg/cloudGallerySyncService"
import restComms from "@/services/RestComms"
import {useGallerySyncStore} from "@/stores/gallerySync"
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

    // Listen for cloud_upload_failed BLE message (fallback when WiFi dies, glasses can't reach cloud)
    const handleCloudUploadFailed = async (data: {reason?: string; timestamp?: number}) => {
      console.log(`[CloudGallerySync] ❌ =========================================`)
      console.log(`[CloudGallerySync] ❌ RECEIVED cloud_upload_failed BLE message from glasses`)
      console.log(
        `[CloudGallerySync] ❌ Reason: ${data.reason || "unknown"}, timestamp: ${data.timestamp || "unknown"}`,
      )
      console.log(`[CloudGallerySync] ❌ Notifying cloud and triggering download`)
      console.log(`[CloudGallerySync] ❌ =========================================`)

      // Clear upload status in store immediately (so UI updates)
      const store = useGallerySyncStore.getState()
      store.setCloudUploadStatus(false, 0, 0, undefined)

      // Notify cloud of the failure (marks upload session as failed)
      try {
        // TEMPORARY OVERRIDE - DO NOT COMMIT
        const baseUrl = "https://clouddev.ngrok.app"
        // const baseUrl = useSettingsStore.getState().getRestUrl() // Original code
        const token = restComms.getCoreToken()
        if (token) {
          await axios.post(
            `${baseUrl}/api/client/asg/gallery/upload-failed`,
            {reason: data.reason || "network_error"},
            {
              headers: {Authorization: `Bearer ${token}`},
              timeout: 30000,
            },
          )
          console.log("[CloudGallerySync] ✅ Notified cloud of upload failure")
        }
      } catch (error: any) {
        console.warn("[CloudGallerySync] Failed to notify cloud of upload failure:", error?.message || error)
        // Continue anyway - we'll try to download what's available
      }

      // Wait a brief moment for cloud to process the failure, then check for pending items
      // Pass ignoreUploadStatus=true to proceed even if cloud still shows uploading
      // (cloud may not have processed the failure notification yet)
      setTimeout(() => {
        console.log("[CloudGallerySync] 🔄 Checking for pending items after upload failure (ignoring upload status)")
        cloudGallerySyncService.checkPending(true) // Force check even if cloud says uploading
      }, 1000) // 1 second delay to let cloud process
    }

    console.log("[CloudGallerySync] 📡 Registering listener for cloud_upload_failed event")
    GlobalEventEmitter.addListener("cloud_upload_failed", handleCloudUploadFailed)
    console.log("[CloudGallerySync] ✅ Listener registered for cloud_upload_failed event")

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
      GlobalEventEmitter.removeListener("cloud_upload_failed", handleCloudUploadFailed)
      cloudGallerySyncService.stopPolling()
    }
  }, [])

  return null
}
