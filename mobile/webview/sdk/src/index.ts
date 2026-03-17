/**
 * @mentra/webview-sdk
 *
 * JavaScript SDK for building local mini apps (LMA) in MentraOS WebViews.
 *
 * This SDK provides a simple API for:
 * - Displaying text on smartglasses
 * - Controlling microphone state
 * - Receiving transcriptions (online/local)
 * - Receiving audio streams
 * - Receiving movement/IMU data
 *
 * @example
 * ```typescript
 * import { CoreModule, Events } from '@mentra/webview-sdk'
 *
 * // Display text on glasses
 * CoreModule.displayText('Hello from WebView')
 *
 * // Subscribe to transcriptions
 * Events.requestTranscriptions({ type: 'online', fallback: true }, (text) => {
 *   console.log('Transcription:', text)
 * })
 * ```
 */

import {getBridge, Bridge} from "./bridge"
import {getCoreModule} from "./core"
import {getEvents} from "./events"

// Export types
export * from "./types"

// Export Bridge class
export {Bridge}

// Create global instances
const bridge = getBridge()
const coreModule = getCoreModule()
const events = getEvents()

/**
 * Global CoreModule instance for easy access
 */
export const CoreModule = coreModule

/**
 * Global Events instance for easy access
 */
export const Events = events

/**
 * Initialize the SDK
 * Should be called when the page loads
 */
export function initialize(): void {
  if (typeof window === "undefined") {
    console.warn("SDK can only be initialized in a browser environment")
    return
  }

  // Notify native that page is ready
  window.addEventListener("load", () => {
    bridge.send({
      type: "page_ready",
      timestamp: Date.now(),
    })
  })
}

/**
 * Default export with all SDK functionality
 */
export default {
  CoreModule,
  Events,
  initialize,
  Bridge,
}

// Auto-initialize on import
if (typeof window !== "undefined") {
  initialize()
}
