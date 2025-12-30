/**
 * GallerySyncEffect
 * Initializes the gallery sync service on app start so it can handle
 * hotspot events and continue syncing even when the gallery screen isn't open.
 */

import {useEffect} from "react"

import {gallerySyncService} from "@/services/asg/gallerySyncService"

export const GallerySyncEffect = () => {
  useEffect(() => {
    // Initialize the sync service on app mount
    gallerySyncService.initialize()

    // Don't cleanup on unmount - service should persist for app lifetime
    // The service is a singleton and handles its own cleanup when needed
  }, [])

  return null
}
