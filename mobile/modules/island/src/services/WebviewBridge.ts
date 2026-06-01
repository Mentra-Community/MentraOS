/**
 * WebviewBridge — WebView message handler registry.
 *
 * Holds per-packageName send functions so that any service (MiniappHost,
 * webview.tsx) can inject JS into a specific WebView. That's it.
 *
 * Local miniapp message routing goes through LocalMiniappRuntime directly
 * (MiniappHost calls localMiniappRuntime.handleRawMessage). WebviewBridge is
 * not in that path.
 */

class WebviewBridge {
  private static instance: WebviewBridge | null = null
  private messageHandlers: Record<string, (stringified: string) => void> = {}

  private constructor() {}

  public static getInstance(): WebviewBridge {
    if (!WebviewBridge.instance) {
      WebviewBridge.instance = new WebviewBridge()
    }
    return WebviewBridge.instance
  }

  public cleanup() {
    this.messageHandlers = {}
    WebviewBridge.instance = null
  }

  public setWebViewMessageHandler(packageName: string, handler?: (stringified: string) => void) {
    if (handler) {
      this.messageHandlers[packageName] = handler
    } else {
      delete this.messageHandlers[packageName]
    }
  }

  public sendToMiniApp(packageName: string, message: object) {
    const handler = this.messageHandlers[packageName]
    if (!handler) return
    try {
      handler(JSON.stringify(message))
    } catch (error) {
      console.error(`MINICOM: Error sending to ${packageName}:`, error)
    }
  }
}

const webviewBridge = WebviewBridge.getInstance()
export default webviewBridge
