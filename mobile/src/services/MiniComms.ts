import {Linking} from "react-native"
import Share from "react-native-share"
import * as Clipboard from "expo-clipboard"
import {File, Paths} from "expo-file-system"
import CoreModule from "core"

type MiniAppMessageType =
  | "core_fn"
  | "request_mic_audio"
  | "request_transcription"
  | "display_event"
  | "button_click"
  | "page_ready"
  | "custom_action"
  | "share"
  | "open_url"
  | "copy_clipboard"
  | "download"
export interface MiniAppMessage {
  type: MiniAppMessageType
  payload?: any
  timestamp?: number
  requestId?: string
}

class MiniComms {
  private static instance: MiniComms | null = null
  private messageHandlers: Record<string, (stringified: string) => void> = {}

  private constructor() {}

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

      this.handleMessageFromMiniApp(packageName, message)
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

  private async handleShare(packageName: string, message: MiniAppMessage) {
    const {text, title, base64, mimeType, filename, url} = message.payload || {}
    try {
      if (base64) {
        // File share via base64 — write to temp file then share
        const tempFile = new File(Paths.cache, filename || "shared_file")
        tempFile.write(base64, {encoding: "base64"})
        await Share.open({
          url: tempFile.uri,
          type: mimeType || "application/octet-stream",
          filename: filename,
          title: title,
        })
      } else if (url) {
        await Share.open({url, title, message: text})
      } else {
        await Share.open({message: text || "", title})
      }
      this.sendResponse(packageName, message.requestId, {success: true})
    } catch (error: any) {
      // react-native-share throws when user dismisses the share sheet
      if (error?.message?.includes("User did not share")) {
        this.sendResponse(packageName, message.requestId, {success: false, cancelled: true})
      } else {
        console.error("SUPERCOMMS: Share error:", error)
        this.sendResponse(packageName, message.requestId, {success: false, error: error?.message})
      }
    }
  }

  private async handleOpenUrl(_packageName: string, message: MiniAppMessage) {
    const {url} = message.payload || {}
    if (!url || typeof url !== "string") {
      console.warn("SUPERCOMMS: open_url missing url")
      return
    }
    // Block dangerous schemes
    if (url.startsWith("javascript:") || url.startsWith("file:")) {
      console.warn("SUPERCOMMS: open_url blocked dangerous scheme:", url)
      return
    }
    try {
      await Linking.openURL(url)
    } catch (error) {
      console.error("SUPERCOMMS: open_url error:", error)
    }
  }

  private async handleCopyClipboard(packageName: string, message: MiniAppMessage) {
    const {text} = message.payload || {}
    if (typeof text !== "string") {
      console.warn("SUPERCOMMS: copy_clipboard missing text")
      return
    }
    try {
      await Clipboard.setStringAsync(text)
      this.sendResponse(packageName, message.requestId, {success: true})
    } catch (error: any) {
      console.error("SUPERCOMMS: clipboard error:", error)
      this.sendResponse(packageName, message.requestId, {success: false, error: error?.message})
    }
  }

  private async handleDownload(packageName: string, message: MiniAppMessage) {
    const {base64, url, mimeType, filename} = message.payload || {}
    const name = filename || "download"
    try {
      let file: File
      if (base64) {
        file = new File(Paths.cache, name)
        file.write(base64, {encoding: "base64"})
      } else if (url) {
        file = await File.downloadFileAsync(url, new File(Paths.cache, name), {idempotent: true})
      } else {
        console.warn("SUPERCOMMS: download missing base64 or url")
        return
      }
      // Open share sheet so user can choose where to save
      await Share.open({
        url: file.uri,
        type: mimeType || "application/octet-stream",
        filename: name,
      })
      this.sendResponse(packageName, message.requestId, {success: true, filePath: file.uri})
    } catch (error: any) {
      if (error?.message?.includes("User did not share")) {
        this.sendResponse(packageName, message.requestId, {success: true, cancelled: true})
      } else {
        console.error("SUPERCOMMS: download error:", error)
        this.sendResponse(packageName, message.requestId, {success: false, error: error?.message})
      }
    }
  }

  private sendResponse(packageName: string, requestId: string | undefined, result: any) {
    if (!requestId) return
    this.sendToMiniApp(packageName, {
      type: "bridge_response" as MiniAppMessageType,
      payload: {requestId, ...result},
    })
  }

  // process the message from the mini app
  private handleMessageFromMiniApp(packageName: string, message: MiniAppMessage) {
    switch (message.type) {
      case "core_fn":
        this.handleCoreFn(message)
        break
      case "request_mic_audio":
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
      case "share":
        this.handleShare(packageName, message)
        break
      case "open_url":
        this.handleOpenUrl(packageName, message)
        break
      case "copy_clipboard":
        this.handleCopyClipboard(packageName, message)
        break
      case "download":
        this.handleDownload(packageName, message)
        break
      default:
        console.log(`SUPERCOMMS: Unknown message type: ${message.type}`)
    }
  }
}

const miniComms = MiniComms.getInstance()
export default miniComms
