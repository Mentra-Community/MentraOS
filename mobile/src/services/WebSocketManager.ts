import {EventEmitter} from "events"

import restComms from "@/services/RestComms"
import {useConnectionStore} from "@/stores/connection"
import {getGlasesInfoPartial, useGlassesStore} from "@/stores/glasses"
import {BackgroundTimer} from "@/utils/timers"

// ---------------------------------------------------------------------------
// Liveness detection constants
// ---------------------------------------------------------------------------
// The SERVER sends {"type":"ping"} every 2 s. The client responds with
// {"type":"pong"} (via SocketComms.handle_ping). This bidirectional traffic
// keeps nginx proxy-read-timeout AND proxy-send-timeout alive, and gives the
// client a guaranteed periodic message to track liveness against.
//
// The client does NOT send its own pings — the server's pings are sufficient,
// and skipping the client ping sender saves battery on mobile.

// If we haven't received ANY message (server ping, transcription, display
// event, …) within this window, consider the connection dead and force-close.
// 4 s = missing two full server-ping cycles — brief blips won't trigger this.
const LIVENESS_TIMEOUT_MS = 4_000

// How often we check whether lastMessageTime has gone stale.
const LIVENESS_CHECK_INTERVAL_MS = 2_000

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
  private lastMessageTime: number = 0
  private livenessCheckInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0

  private constructor() {
    super()
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
      // Reset the liveness clock on EVERY incoming message — pings, pongs,
      // transcription data, display events, anything.  This is the heartbeat.
      this.lastMessageTime = Date.now()
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
   * Start the liveness monitor.
   *
   * A single repeating timer checks whether we've received ANY message
   * within LIVENESS_TIMEOUT_MS.  The server sends {"type":"ping"} every
   * 2 s, so under normal conditions lastMessageTime resets constantly.
   * If the server stops sending (network black-hole, Cloudflare edge
   * rebalance, pod crash without close frame, etc.), the liveness check
   * fires within 4-6 s and force-closes the connection so we can
   * reconnect immediately — instead of waiting 30-120+ s for the OS
   * TCP keepalive to notice.
   *
   * No client-side ping sender is needed: the server's pings already
   * generate bidirectional traffic (server→ping, client→pong via
   * SocketComms.handle_ping) which keeps nginx and Cloudflare alive.
   * Omitting the client ping sender saves battery on mobile.
   */
  private startLivenessMonitor() {
    // In case we're called twice without a stop in between
    this.stopLivenessMonitor()

    this.lastMessageTime = Date.now()

    // --- Liveness checker ---
    this.livenessCheckInterval = BackgroundTimer.setInterval(() => {
      const elapsed = Date.now() - this.lastMessageTime
      if (elapsed > LIVENESS_TIMEOUT_MS) {
        console.log(`WSM: Liveness timeout — no message for ${elapsed}ms, force-closing`)

        // Force-close the dead connection.  detachAndCloseSocket nulls the
        // handlers so the stale onclose won't fire and double-reconnect.
        this.stopLivenessMonitor()
        this.detachAndCloseSocket()
        this.updateStatus(WebSocketStatus.DISCONNECTED)
        this.startReconnectInterval()
      }
    }, LIVENESS_CHECK_INTERVAL_MS)
  }

  /**
   * Stop the liveness monitor — clear both intervals.
   */
  private stopLivenessMonitor() {
    if (this.livenessCheckInterval) {
      BackgroundTimer.clearInterval(this.livenessCheckInterval)
      this.livenessCheckInterval = 0
    }
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

      // Consume pong silently — it already reset lastMessageTime in onmessage.
      // Don't forward to SocketComms; no listener cares about pongs.
      if (message.type === "pong") {
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
