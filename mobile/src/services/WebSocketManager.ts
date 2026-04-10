import {EventEmitter} from "events"

import restComms from "@/services/RestComms"
import {useConnectionStore} from "@/stores/connection"
import {getGlasesInfoPartial, useGlassesStore} from "@/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {BackgroundTimer} from "@/utils/timers"

// ---------------------------------------------------------------------------
// Liveness detection constants
// ---------------------------------------------------------------------------
// The CLIENT sends {"type":"ping"} every 5 s. The server responds with
// {"type":"pong"}. If a pong is missed, the client reconnects immediately.

// How often the client sends a ping to the server.
const PING_INTERVAL_MS = 5_000

// If no pong is received within this window, consider the connection
// dead and reconnect. This timeout is measured from the last ping sent,
// not from connect time, so the first timer tick always sends a ping
// instead of immediately declaring the socket stale.
const PONG_TIMEOUT_MS = 5_000

// Delay between reconnect attempts after a disconnect.
const RECONNECT_INTERVAL_MS = 5_000

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

  // Liveness detection state
  private lastPingAt: number = 0
  private lastPongTime: number = 0
  private awaitingPong: boolean = false
  private pingInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0

  private constructor() {
    super()
    GlobalEventEmitter.on("NO_ACTIVE_SESSION", this.handleNoActiveSession)
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager()
    }
    return WebSocketManager.instance
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

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

  /**
   * Detach all event handlers from the current WebSocket and close it.
   *
   * Nulling out handlers BEFORE calling .close() prevents a stale `onclose`
   * callback from firing asynchronously and kicking off a rogue reconnect
   * loop (e.g. when switching backends: disconnect() sets
   * manuallyDisconnected = true, connect() resets it to false, then the
   * stale onclose fires and calls startReconnectInterval against the old URL).
   */
  private detachAndCloseSocket() {
    if (this.webSocket) {
      this.webSocket.onclose = null
      this.webSocket.onerror = null
      this.webSocket.onmessage = null
      this.webSocket.onopen = null
      this.webSocket.close()
      this.webSocket = null
    }
  }

  public connect(url: string, coreToken: string) {
    console.log(`WSM: connect: ${url}`)
    this.manuallyDisconnected = false
    this.url = url
    this.coreToken = coreToken

    // Tear down any existing connection cleanly
    this.stopLivenessMonitor()
    this.detachAndCloseSocket()

    // Update status to connecting and set URL in store
    this.updateStatus(WebSocketStatus.CONNECTING)
    const store = useConnectionStore.getState()
    store.setUrl(url)

    // Create new WebSocket with authorization header
    const wsUrl = new URL(url)
    wsUrl.searchParams.set("token", coreToken)
    wsUrl.searchParams.set("livekit", "true")
    wsUrl.searchParams.set("udpEncryption", "true")

    console.log("WSM: Connecting to WebSocket URL:", wsUrl.toString().replace(/token=[^&]+/, "token=REDACTED"))

    this.webSocket = new WebSocket(wsUrl.toString())

    // Set up event handlers
    this.webSocket.onopen = () => {
      console.log("WSM: WebSocket connection established")
      this.updateStatus(WebSocketStatus.CONNECTED)
      this.startLivenessMonitor()
    }

    this.webSocket.onmessage = (event) => {
      this.handleIncomingMessage(event.data)
    }

    this.webSocket.onerror = (_error) => {
      console.log("WSM: WebSocket error:", _error)
      this.stopLivenessMonitor()
      this.updateStatus(WebSocketStatus.ERROR)
      store.setError(_error?.toString() || "WebSocket error")
      this.startReconnectInterval()
    }

    this.webSocket.onclose = (_event) => {
      console.log("WSM: Connection closed with code:", _event.code)
      this.stopLivenessMonitor()
      this.updateStatus(WebSocketStatus.DISCONNECTED)
      this.startReconnectInterval()
    }
  }

  private actuallyReconnect() {
    console.log("WSM: Attempting reconnect")
    const store = useConnectionStore.getState()

    // Reconnect from both DISCONNECTED and ERROR states.
    // The old code only reconnected from DISCONNECTED — if onerror fired
    // without a subsequent onclose, the client was stuck in ERROR forever.
    if (store.status === WebSocketStatus.DISCONNECTED || store.status === WebSocketStatus.ERROR) {
      if (this.url && this.coreToken) {
        this.connect(this.url, this.coreToken)
      }
    }
    if (store.status === WebSocketStatus.CONNECTED) {
      console.log("WSM: Connected, stopping reconnect interval")
      BackgroundTimer.clearInterval(this.reconnectInterval)
    }
  }

  private startReconnectInterval() {
    console.log("WSM: Starting reconnect interval, manuallyDisconnected:", this.manuallyDisconnected)
    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    // Don't start reconnect if manually disconnected
    if (this.manuallyDisconnected) {
      return
    }

    this.reconnectInterval = BackgroundTimer.setInterval(this.actuallyReconnect.bind(this), RECONNECT_INTERVAL_MS)
  }

  private reconnectNow(reason: string) {
    console.log(`WSM: Immediate reconnect requested: ${reason}`)
    if (this.manuallyDisconnected) {
      return
    }

    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    this.stopLivenessMonitor()
    this.detachAndCloseSocket()
    this.updateStatus(WebSocketStatus.DISCONNECTED)

    if (this.url && this.coreToken) {
      this.connect(this.url, this.coreToken)
      return
    }

    this.startReconnectInterval()
  }

  private handleNoActiveSession = () => {
    if (this.previousStatus === WebSocketStatus.CONNECTING) {
      return
    }

    this.reconnectNow("REST request returned NO_ACTIVE_SESSION")
  }

  public disconnect() {
    this.manuallyDisconnected = true

    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    this.stopLivenessMonitor()
    this.detachAndCloseSocket()
    this.updateStatus(WebSocketStatus.DISCONNECTED)
  }

  // -------------------------------------------------------------------------
  // Liveness detection
  // -------------------------------------------------------------------------

  /**
   * Start the client-initiated ping-pong liveness monitor.
   *
   * Every PING_INTERVAL_MS the client sends {"type":"ping"} to the server.
   * The server responds with {"type":"pong"} which updates lastPongTime
   * (via handleIncomingMessage → pong branch).
   */
  private startLivenessMonitor() {
    this.stopLivenessMonitor()

    this.lastPingAt = 0
    this.lastPongTime = Date.now()
    this.awaitingPong = false

    this.sendPing()

    this.pingInterval = BackgroundTimer.setInterval(() => {
      if (!this.isConnected()) return

      if (this.awaitingPong) {
        const elapsed = Date.now() - this.lastPingAt
        if (elapsed >= PONG_TIMEOUT_MS) {
          this.reconnectNow(`pong timeout after ${elapsed}ms`)
        }
        return
      }

      this.sendPing()
    }, PING_INTERVAL_MS)
  }

  private sendPing() {
    if (!this.isConnected()) {
      return
    }

    this.lastPingAt = Date.now()
    this.awaitingPong = true

    try {
      this.webSocket?.send(JSON.stringify({type: "ping"}))
    } catch (error) {
      console.log("WSM: Error sending ping:", error)
    }
  }

  /**
   * Stop the liveness monitor — clear the ping interval.
   */
  private stopLivenessMonitor() {
    if (this.pingInterval) {
      BackgroundTimer.clearInterval(this.pingInterval)
      this.pingInterval = 0
    }

    this.awaitingPong = false
    this.lastPingAt = 0
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  public isConnected(): boolean {
    return this.previousStatus === WebSocketStatus.CONNECTED
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

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

      // Pong received — update liveness timestamp. Don't forward to SocketComms.
      if (message.type === "pong") {
        this.lastPongTime = Date.now()
        this.awaitingPong = false
        return
      }

      // Forward message to listeners
      this.emit("message", message)
    } catch (error) {
      console.log("WSM: Failed to parse WebSocket message:", error)
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  public cleanup() {
    console.log("WSM: cleanup()")
    this.disconnect()
    this.webSocket = null
    const store = useConnectionStore.getState()
    store.reset()
  }
}

const wsManager = WebSocketManager.getInstance()
export default wsManager
