import {EventEmitter} from "events"

import mantle from "./MantleManager"

export interface SuperWebViewMessage {
  type: string
  payload?: any
  timestamp?: number
}

class MiniComms {
  private static instance: MiniComms | null = null
  private eventEmitter: EventEmitter
  private webViewMessageHandler: ((message: string) => void) | null = null

  private constructor() {
    this.eventEmitter = new EventEmitter()
  }

  public static getInstance(): MiniComms {
    if (!MiniComms.instance) {
      MiniComms.instance = new MiniComms()
    }
    return MiniComms.instance
  }

  public cleanup() {
    this.eventEmitter.removeAllListeners()
    this.webViewMessageHandler = null
    MiniComms.instance = null
  }

  // Register the WebView message sender
  public setWebViewMessageHandler(handler: (message: string) => void) {
    this.webViewMessageHandler = handler
  }

  // Send message to WebView
  public sendToWebView(message: SuperWebViewMessage) {
    if (!this.webViewMessageHandler) {
      console.warn("SUPERCOMMS: No WebView message handler registered")
      return
    }

    try {
      const jsonMessage = JSON.stringify(message)
      this.webViewMessageHandler(jsonMessage)
      console.log(`SUPERCOMMS: Sent to WebView: ${message.type}`)
    } catch (error) {
      console.error(`SUPERCOMMS: Error sending to WebView:`, error)
    }
  }

  // Handle incoming message from WebView
  public handleWebViewMessage(data: string) {
    try {
      const message: SuperWebViewMessage = JSON.parse(data)
      console.log(`SUPERCOMMS: Received from WebView: ${message.type}`)

      // Emit event for any listeners
      this.eventEmitter.emit("message", message)

      // Handle specific message types
      this.handleMessage(message)
    } catch (error) {
      console.error(`SUPERCOMMS: Error parsing WebView message:`, error)
    }
  }

  private handle_data_update(message: SuperWebViewMessage) {
    console.log(`SUPERCOMMS: Data updated:`, message.payload.count)
    mantle.displayTextMain(`count: ${message.payload.count}`)
  }

  // Subscribe to messages from WebView
  public on(event: string, listener: (message: SuperWebViewMessage) => void) {
    this.eventEmitter.on(event, listener)
  }

  // Unsubscribe from messages
  public off(event: string, listener: (message: SuperWebViewMessage) => void) {
    this.eventEmitter.off(event, listener)
  }

  // Message handlers - these handle specific message types from WebView
  private handleMessage(message: SuperWebViewMessage) {
    switch (message.type) {
      case "button_click":
        this.handleButtonClick(message)
        break

      case "page_ready":
        this.handlePageReady(message)
        break

      case "custom_action":
        this.handleCustomAction(message)
        break

      case "data_update":
        this.handle_data_update(message)
        break

      default:
        console.log(`SUPERCOMMS: Unknown message type: ${message.type}`)
    }
  }

  private handleButtonClick(message: SuperWebViewMessage) {
    console.log(`SUPERCOMMS: Button clicked:`, message.payload)

    // Send a response back to WebView
    this.sendToWebView({
      type: "button_click_response",
      payload: {
        buttonId: message.payload?.buttonId,
        status: "success",
        message: `Button ${message.payload?.buttonId} clicked!`,
      },
      timestamp: Date.now(),
    })
  }

  private handlePageReady(_message: SuperWebViewMessage) {
    console.log(`SUPERCOMMS: Page is ready`)

    // Send initial data to WebView
    this.sendToWebView({
      type: "init_data",
      payload: {
        message: "Welcome to SuperApp!",
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    })
  }

  private handleCustomAction(_message: SuperWebViewMessage) {
    console.log(`SUPERCOMMS: Custom action:`, _message.payload)
  }

  // Public API for sending specific commands to WebView
  public sendNotification(title: string, message: string) {
    this.sendToWebView({
      type: "notification",
      payload: {title, message},
      timestamp: Date.now(),
    })
  }

  public updateData(data: any) {
    this.sendToWebView({
      type: "data_update",
      payload: data,
      timestamp: Date.now(),
    })
  }
}

const miniComms = MiniComms.getInstance()
export default miniComms
