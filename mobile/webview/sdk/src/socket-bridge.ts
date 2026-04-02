const MINISOCKET_PORT = 8765
const RECONNECT_DELAY_MS = 2000
const MAX_RECONNECT_ATTEMPTS = 10

type AudioHandler = (audio: ArrayBuffer) => void
type ConnectionHandler = (connected: boolean) => void

/**
 * WebSocket bridge for receiving binary audio data from the MentraOS host app.
 *
 * Automatically connects to the localhost WebSocket server run by MiniSockets
 * on the React Native side. Receives ArrayBuffer audio frames over binary
 * WebSocket messages.
 */
export class SocketBridge {
  private ws: WebSocket | null = null
  private audioHandlers: Set<AudioHandler> = new Set()
  private connectionHandlers: Set<ConnectionHandler> = new Set()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false
  private _connected = false

  constructor(private port: number = MINISOCKET_PORT) {}

  /**
   * Connect to the MiniSockets WebSocket server.
   * Automatically called on SDK init — usually you don't need to call this.
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.intentionallyClosed = false

    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`)
      this.ws.binaryType = "arraybuffer"

      this.ws.onopen = () => {
        console.log("[SocketBridge] Connected")
        this.reconnectAttempts = 0
        this._connected = true
        this.notifyConnection(true)
      }

      this.ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          for (const handler of this.audioHandlers) {
            handler(event.data)
          }
        } else if (typeof event.data === "string") {
          // Text messages can be handled later for control/signaling
          console.log("[SocketBridge] Text message:", event.data)
        }
      }

      this.ws.onclose = () => {
        console.log("[SocketBridge] Disconnected")
        this._connected = false
        this.notifyConnection(false)
        this.ws = null
        if (!this.intentionallyClosed) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (err) => {
        // onclose will fire after this, which handles reconnect
        console.warn("[SocketBridge] Error:", err)
      }
    } catch (err) {
      console.error("[SocketBridge] Failed to create WebSocket:", err)
      this.scheduleReconnect()
    }
  }

  /**
   * Disconnect from the server. Stops auto-reconnect.
   */
  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }

  /**
   * Register a handler for incoming audio data (ArrayBuffer).
   * Returns an unsubscribe function.
   */
  onAudio(handler: AudioHandler): () => void {
    this.audioHandlers.add(handler)
    return () => this.audioHandlers.delete(handler)
  }

  /**
   * Register a handler for connection state changes.
   * Returns an unsubscribe function.
   */
  onConnection(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  get connected(): boolean {
    return this._connected
  }

  // --- Internal ---

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("[SocketBridge] Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 5)
    console.log(`[SocketBridge] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private notifyConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected)
    }
  }
}

// Global instance
let socketBridgeInstance: SocketBridge | null = null

/**
 * Get the global SocketBridge instance.
 * Auto-connects on first call.
 */
export function getSocketBridge(): SocketBridge {
  if (!socketBridgeInstance) {
    socketBridgeInstance = new SocketBridge()
    if (typeof window !== "undefined") {
      socketBridgeInstance.connect()
    }
  }
  return socketBridgeInstance
}
