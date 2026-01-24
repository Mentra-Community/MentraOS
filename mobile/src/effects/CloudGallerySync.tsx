/**
 * Cloud Gallery Sync Effect
 * Monitors WiFi state and manages cloud gallery polling
 * Coordinates with glasses upload to prevent race conditions
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

    // Listen for glasses starting cloud upload - pause phone downloads
    const handleCloudUploadStarted = (data: {total_files: number; timestamp: number}) => {
      console.log(`[CloudGallerySync] 🚫 Glasses started cloud upload: ${data.total_files} files - pausing downloads`)
      cloudGallerySyncService.setGlassesUploading(true)
    }

    // Listen for cloud upload completion notifications from glasses (per-file)
    const handleCloudUploadComplete = (data: {filename: string; timestamp: number}) => {
      console.log(`[CloudGallerySync] 📱 Received cloud upload notification: ${data.filename}`)
      // Don't trigger immediate download - wait for gallery_status with 0 items
      // to confirm all uploads are done
    }

    // Listen for gallery status updates - resume downloads when glasses have no more photos
    const handleGalleryStatus = (data: {photos: number; videos: number; total: number; has_content: boolean}) => {
      console.log(`[CloudGallerySync] 📊 Received gallery status: ${data.photos} photos, ${data.videos} videos`)

      // If glasses have no content left, they're done uploading
      // Resume cloud downloads
      if (data.total === 0 && cloudGallerySyncService.isGlassesUploading()) {
        console.log("[CloudGallerySync] ✅ Glasses finished uploading (0 items remaining) - resuming downloads")
        cloudGallerySyncService.setGlassesUploading(false)
      }
    }

    GlobalEventEmitter.addListener("cloud_upload_started", handleCloudUploadStarted)
    GlobalEventEmitter.addListener("cloud_upload_complete", handleCloudUploadComplete)
    GlobalEventEmitter.addListener("gallery_status", handleGalleryStatus)

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
      GlobalEventEmitter.removeListener("cloud_upload_started", handleCloudUploadStarted)
      GlobalEventEmitter.removeListener("cloud_upload_complete", handleCloudUploadComplete)
      GlobalEventEmitter.removeListener("gallery_status", handleGalleryStatus)
      cloudGallerySyncService.stopPolling()
    }
  }, [])

  return null
}
