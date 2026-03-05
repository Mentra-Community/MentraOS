import mantle from "./MantleManager"
import CoreModule from "core"

export interface MiniAppMessage {
  type: string
  payload?: any
  timestamp?: number
}

class MiniComms {
  private static instance: MiniComms | null = null
  private messageHandlers: Record<string, (stringified: string) => void> = {}

  private constructor() {
  }

  public static getInstance(): MiniComms {
    if (!MiniComms.instance) {
      MiniComms.instance = new MiniComms()
    }
    return MiniComms.instance
  }

  public cleanup() {
    MiniComms.instance = null
  }

  // Register the WebView message sender
  public setWebViewMessageHandler(packageName: string, handler?: (stringified: string) => void) {
    if (handler) {
      this.messageHandlers[packageName] = handler
    } else {
      delete this.messageHandlers[packageName]
    }
  }

  // Send message to WebView
  public sendToMiniApp(packageName: string, message: MiniAppMessage) {
    if (!this.messageHandlers[packageName]) {
      console.warn("SUPERCOMMS: No WebView message handler registered")
      return
    }

    try {
      const jsonMessage = JSON.stringify(message)
      this.messageHandlers[packageName](jsonMessage)
      console.log(`SUPERCOMMS: Sent to WebView: ${message.type}`)
    } catch (error) {
      console.error(`SUPERCOMMS: Error sending to WebView:`, error)
    }
  }

  // Handle incoming message from WebView
  public handleRawMessageFromMiniApp(packageName: string, stringified: string) {
    try {
      const message: MiniAppMessage = JSON.parse(stringified)
      console.log(`SUPERCOMMS: Received from MiniApp: ${message.type} from ${packageName}`)

      // Handle specific message types
      // this.handleMessageFromMiniApp(packageName, message)
    } catch (error) {
      console.error(`SUPERCOMMS: Error parsing WebView message:`, error)
    }
  }

  private handleCoreFn(message: MiniAppMessage) {
    const {fn, args} = message.payload
    console.log(`SUPERCOMMS: Core function:`, fn, args)
    CoreModule[fn](...args)
  }

  private handleButtonClick(message: MiniAppMessage) {
    console.log(`SUPERCOMMS: Button clicked:`, message.payload)

    // Send a response back to WebView
    // this.sendToMiniApp({
    //   type: "button_click_response",
    //   payload: {
    //     buttonId: message.payload?.buttonId,
    //     status: "success",
    //     message: `Button ${message.payload?.buttonId} clicked!`,
    //   },
    //   timestamp: Date.now(),
    // })
  }

  private handlePageReady(_message: MiniAppMessage) {
    console.log(`SUPERCOMMS: Page is ready`)

    // // Send initial data to WebView
    // this.sendToWebView({
    //   type: "init_data",
    //   payload: {
    //     message: "Welcome to SuperApp!",
    //     timestamp: Date.now(),
    //   },
    //   timestamp: Date.now(),
    // })
  }

  private handleCustomAction(_message: MiniAppMessage) {
    console.log(`SUPERCOMMS: Custom action:`, _message.payload)
  }

  // process the message from the mini app
  private handleMessageFromMiniApp(packageName: string, message: MiniAppMessage) {
    switch (message.type) {
      case "core_fn":
        this.handleCoreFn(message)
        break
      case "request_mic":
        // this.handleRequestAudio(message)
        break
      case "request_transcription":
        // this.handleRequestTranscription(message)
        break
      case "display_event":
        // this.handleDisplayEvent(message)
        break
      case "button_click":
        this.handleButtonClick(message)
        break

      case "page_ready":
        this.handlePageReady(message)
        break

      case "custom_action":
        this.handleCustomAction(message)
        break

      default:
        console.log(`SUPERCOMMS: Unknown message type: ${message.type}`)
    }
  }

}

const miniComms = MiniComms.getInstance()
export default miniComms
