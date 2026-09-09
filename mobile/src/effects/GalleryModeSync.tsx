import {useEffect, useState} from "react"

import {engine, SETTINGS, useSetting} from "@mentra/engine"

import {shouldUseMentraLiveNativeCapture} from "@/effects/buttonCapturePolicy"

/**
 * Syncs Mentra Live gallery mode to active hardware-button subscriptions.
 *
 * Gallery mode (capture enabled) is TRUE when:
 * - No miniapp subscribes to button_press
 *
 * Gallery is only a media viewer: opening or closing it does not control capture.
 * Button events are delivered by the engine; the glasses attempt native capture
 * when enabled and reject it if the camera is busy. No app is launched here.
 */
export function GalleryModeSync() {
  const [galleryMode, setGalleryMode] = useSetting(SETTINGS.gallery_mode.key)
  const [buttonPressSubscribers, setButtonPressSubscribers] = useState(() => engine.miniapps.buttonPressSubscribers())

  useEffect(() => {
    const unsubscribe = engine.miniapps.onButtonPressSubscribersChanged(setButtonPressSubscribers)
    // Close the snapshot/subscription race by refreshing after registration.
    setButtonPressSubscribers(engine.miniapps.buttonPressSubscribers())
    return unsubscribe
  }, [])

  useEffect(() => {
    const shouldEnableCapture = shouldUseMentraLiveNativeCapture(buttonPressSubscribers)

    if (galleryMode !== shouldEnableCapture) {
      setGalleryMode(shouldEnableCapture)
    }
  }, [buttonPressSubscribers, galleryMode, setGalleryMode])

  return null
}
