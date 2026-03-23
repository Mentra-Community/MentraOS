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
import {getSocketBridge, SocketBridge} from "./socket-bridge"

// Export types
export * from "./types"

// Export Bridge class
export {Bridge}

// Export SocketBridge class
export {SocketBridge}

// Create global instances
const bridge = getBridge()
const coreModule = getCoreModule()
const events = getEvents()
const socketBridge = getSocketBridge()

/**
 * Global CoreModule instance for easy access
 */
export const CoreModule = coreModule

/**
 * Global Events instance for easy access
 */
export const Events = events

/**
 * Global SocketBridge instance — auto-connects to MiniSockets server
 *
 * @example
 * ```typescript
 * import { Audio } from '@mentra/webview-sdk'
 *
 * Audio.onAudio((buffer: ArrayBuffer) => {
 *   // process raw audio PCM data
 * })
 * ```
 */
export const Audio = socketBridge

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
  Audio,
  initialize,
  Bridge,
  SocketBridge,
}

// Auto-initialize on import
if (typeof window !== "undefined") {
  initialize()
}
