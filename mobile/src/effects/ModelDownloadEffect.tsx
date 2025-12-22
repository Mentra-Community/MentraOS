/**
 * ModelDownloadEffect
 * Initializes the model download service on app start so it can handle
 * downloads even when the transcription settings screen isn't open.
 */

import {useEffect} from "react"

import {modelDownloadService} from "@/services/modelDownloadService"

export const ModelDownloadEffect = () => {
  useEffect(() => {
    // Initialize the download service on app mount
    modelDownloadService.initialize()

    // Don't cleanup on unmount - service should persist for app lifetime
    // The service is a singleton and handles its own cleanup when needed
  }, [])

  return null
}
