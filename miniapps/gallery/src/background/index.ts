/**
 * Background JSContext entry point — Gallery miniapp.
 *
 * Loaded once by the host inside a per-miniapp JSContext. The controller owns
 * the photo library (blob storage), capture, and favorites; the UI WebView is
 * a thin React surface that talks to it over the channel bus.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {GalleryController} from "./controllers/GalleryController"

registerMiniapp((session) => {
  try {
    new GalleryController(session).start()
  } catch (err) {
    console.error("[gallery] GalleryController failed to start", err)
  }
})
