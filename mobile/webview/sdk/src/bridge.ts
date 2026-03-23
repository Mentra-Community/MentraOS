import type {IncomingMessage, OutgoingMessage, SubscriptionHandler, SubscriptionType} from "./types"

/**
 * Extended Window interface for React Native WebView
 */
declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void
    }
    receiveNativeMessage?: (messageStr: string) => void
  }
}

/**
 * Bridge class for communication between WebView and React Native
 */
export class Bridge {
  private subscriptions: Map<SubscriptionType, SubscriptionHandler | null>

  constructor() {
    this.subscriptions = new Map([
      ["transcription", null],
      ["audio", null],
      ["movement", null],
    ])

    // Set up global message receiver
    if (typeof window !== "undefined") {
      window.receiveNativeMessage = (messageStr: string) => {
        try {
          const message = JSON.parse(messageStr) as IncomingMessage
          this.handleNativeMessage(message)
        } catch (error) {
          console.error("Error parsing native message:", error)
        }
      }
    }
  }

  /**
   * Handle incoming messages from native
   */
  private handleNativeMessage(message: IncomingMessage): void {
    const handler = this.subscriptions.get(message.type as SubscriptionType)
    if (handler) {
      handler(message.payload)
    }
  }

  /**
   * Send message to native
   */
  send(message: OutgoingMessage): void {
    if (typeof window === "undefined" || !window.ReactNativeWebView) {
      console.error("ReactNativeWebView not available")
      return
    }
    window.ReactNativeWebView.postMessage(JSON.stringify(message))
  }

  /**
   * Subscribe to a specific event type
   */
  subscribe(type: SubscriptionType, handler: SubscriptionHandler): void {
    this.subscriptions.set(type, handler)
  }

  /**
   * Unsubscribe from a specific event type
   */
  unsubscribe(type: SubscriptionType): void {
    this.subscriptions.set(type, null)
  }
}

// Global bridge instance
let bridgeInstance: Bridge | null = null

/**
 * Get the global bridge instance
 */
export function getBridge(): Bridge {
  if (!bridgeInstance) {
    bridgeInstance = new Bridge()
  }
  return bridgeInstance
}
