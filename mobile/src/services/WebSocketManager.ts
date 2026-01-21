import {EventEmitter} from "events"

import restComms from "@/services/RestComms"
import {useConnectionStore} from "@/stores/connection"
import {getGlasesInfoPartial, useGlassesStore} from "@/stores/glasses"
import {BackgroundTimer} from "@/utils/timers"

export enum WebSocketStatus {
  DISCONNECTED = "disconnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
  ERROR = "error",
}

class WebSocketManager extends EventEmitter {
  private static instance: WebSocketManager | null = null
  private webSocket: WebSocket | null = null
  private previousStatus: WebSocketStatus = WebSocketStatus.DISCONNECTED
  private url: string | null = null
  private coreToken: string | null = null
  private reconnectInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
  private manuallyDisconnected: boolean = false

  private constructor() {
    super()
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager()
    }
    return WebSocketManager.instance
  }

  // things to run when the websocket status changes to connected:
  private onConnect() {
    const statusObj = getGlasesInfoPartial(useGlassesStore.getState())
    restComms.updateGlassesState(statusObj)
  }

  // Only emit when status actually changes
  private updateStatus(newStatus: WebSocketStatus) {
    if (newStatus !== this.previousStatus) {
      this.previousStatus = newStatus

      // Update the connection store
      const store = useConnectionStore.getState()
      store.setStatus(newStatus)

      if (newStatus === WebSocketStatus.CONNECTED) {
        this.onConnect()
      }
    }
  }

  public connect(url: string, coreToken: string) {
    console.log(`WSM: connect: ${url}, ${coreToken}`)
    // mantle.displayTextMain(`WSM: connect: ${url}, ${coreToken}`)
    this.manuallyDisconnected = false
    this.url = url
    this.coreToken = coreToken

    // Disconnect existing connection if any
    if (this.webSocket) {
      this.webSocket.onclose = null
      this.webSocket.onerror = null
      this.webSocket.onmessage = null
      this.webSocket.onopen = null
      this.webSocket.close()
      this.webSocket = null
    }

    // Update status to connecting and set URL in store
    this.updateStatus(WebSocketStatus.CONNECTING)
    const store = useConnectionStore.getState()
    store.setUrl(url)

    // Create new WebSocket with authorization header
    const wsUrl = new URL(url)
    wsUrl.searchParams.set("token", coreToken)
    wsUrl.searchParams.set("livekit", "true")

    this.webSocket = new WebSocket(wsUrl.toString())

    // Set up event handlers
    this.webSocket.onopen = () => {
      console.log("WSM: WebSocket connection established")
      // mantle.displayTextMain(`WSM: WebSocket connection established`)
      this.updateStatus(WebSocketStatus.CONNECTED)
    }

    this.webSocket.onmessage = (event) => {
      this.handleIncomingMessage(event.data)
    }

    this.webSocket.onerror = (_error) => {
      console.log("WSM: WebSocket error:", _error) // Commented out - unrelated to gallery sync
      // mantle.displayTextMain(`WSM: WebSocket error: ${_error?.toString() || "WebSocket error"}`)
      this.updateStatus(WebSocketStatus.ERROR)
      store.setError(_error?.toString() || "WebSocket error")
      this.startReconnectInterval()
    }

    this.webSocket.onclose = (_event) => {
      console.log("WSM: Connection closed with code:", _event.code) // Commented out - unrelated to gallery sync
      // mantle.displayTextMain(`WSM: Connection closed with code: ${_event.code}`)
      this.updateStatus(WebSocketStatus.DISCONNECTED)
      this.startReconnectInterval()
    }
  }

  private actuallyReconnect() {
    console.log("WSM: Attempting reconnect")
    // mantle.displayTextMain(`WSM: Attempting reconnect`)
    const store = useConnectionStore.getState()
    if (store.status === WebSocketStatus.DISCONNECTED) {
      this.connect(this.url!, this.coreToken!)
    }
    if (store.status === WebSocketStatus.CONNECTED) {
      console.log("WSM: Connected, stopping reconnect interval")
      // mantle.displayTextMain(`WSM: Connected, stopping reconnect interval`)
      BackgroundTimer.clearInterval(this.reconnectInterval)
    }
  }

  private startReconnectInterval() {
    console.log("WSM: Starting reconnect interval, manuallyDisconnected: ", this.manuallyDisconnected) // Commented out - unrelated to gallery sync
    // mantle.displayTextMain(`WSM: Starting reconnect interval, manuallyDisconnected: ${this.manuallyDisconnected}`)
    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    // Don't start reconnect if manually disconnected
    if (this.manuallyDisconnected) {
      return
    }

    this.reconnectInterval = BackgroundTimer.setInterval(this.actuallyReconnect.bind(this), 5000)
  }

  public disconnect() {
    // mantle.displayTextMain(`WSM: manual disconnect() called`)
    this.manuallyDisconnected = true

    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    if (this.webSocket) {
      this.webSocket.close()
      this.webSocket = null
    }

    this.updateStatus(WebSocketStatus.DISCONNECTED)
  }

  public isConnected(): boolean {
    // return this.webSocket !== null && this.webSocket.readyState === WebSocket.OPEN
    return this.previousStatus === WebSocketStatus.CONNECTED
  }

  // Send JSON message
  public sendText(text: string) {
    if (!this.isConnected()) {
      console.log("WSM: Cannot send message: WebSocket not connected")
      return
    }

    try {
      this.webSocket?.send(text)
    } catch (error) {
      console.log("WSM: Error sending text message:", error)
    }
  }

  // Send binary data (for audio)
  public sendBinary(data: ArrayBuffer | Uint8Array) {
    if (!this.isConnected() && __DEV__ && Math.random() < 0.03) {
      console.log("WSM: Cannot send binary data: WebSocket not connected")
      return
    }

    try {
      this.webSocket?.send(data)
    } catch (error) {
      console.log("WSM: Error sending binary data:", error)
    }
  }

  private handleIncomingMessage(data: string | ArrayBuffer) {
    try {
      let message: any

      if (typeof data === "string") {
        message = JSON.parse(data)
      } else {
        // Handle binary data - convert to string first
        const decoder = new TextDecoder()
        const text = decoder.decode(data)
        message = JSON.parse(text)
      }

      // Forward message to listeners
      this.emit("message", message)
    } catch (error) {
      console.log("WSM: Failed to parse WebSocket message:", error)
    }
  }

  public cleanup() {
    console.log("WSM: cleanup()")
    this.disconnect()
    this.removeAllListeners()
    this.webSocket = null
    const store = useConnectionStore.getState()
    store.reset()
  }
}

const wsManager = WebSocketManager.getInstance()
export default wsManager
