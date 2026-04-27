import {EventEmitter} from "events"

import restComms from "@/services/RestComms"
import {WebSocketStatus} from "@/services/ws-types"
import {useConnectionStore} from "@/stores/connection"
import {getGlasesInfoPartial, useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {BackgroundTimer} from "@/utils/timers"

export {WebSocketStatus}

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

// How long we wait for the old WebSocket's close event to fire before
// starting a new WebSocket. Prevents the server from briefly observing
// two active sockets for the same user (which it logs as
// "Glasses connection closed (stale — newer WebSocket already active)").
// 500 ms comfortably covers typical TCP close handshakes on mobile
// networks without noticeably delaying legitimate reconnects.
const CLOSE_WAIT_TIMEOUT_MS = 500

class WebSocketManager extends EventEmitter {
  private static instance: WebSocketManager | null = null
  private webSocket: WebSocket | null = null
  private previousStatus: WebSocketStatus = WebSocketStatus.DISCONNECTED
  private coreToken: string | null = null
  private reconnectInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
  private manuallyDisconnected: boolean = false

  // Liveness detection state
  private lastPingAt: number = 0
  private lastPongTime: number = 0
  private awaitingPong: boolean = false
  private pingInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0

  // Serializes concurrent connect() calls via a promise chain: each caller
  // appends performConnect() onto the tail so only one runs at a time. Three
  // paths can trigger connect(): backend_url subscription, NO_ACTIVE_SESSION,
  // and actuallyReconnect. The earlier single-slot connectInFlight let
  // multiple callers await the same promise and then all resume past it —
  // each calling performConnect in parallel, each constructing a new
  // WebSocket while detachAndCloseSocket early-returned on a null socket,
  // and orphaning whichever one lost the race to assign this.webSocket. A
  // chain forces real serialization across any number of concurrent callers.
  private connectChain: Promise<void> = Promise.resolve()

  // Monotonic token that lets an in-flight performConnect detect it has been
  // superseded (by a newer connect() or by disconnect() / cleanup()) while
  // awaiting detachAndCloseSocket()'s up-to-500ms close. After the await the
  // attempt compares its captured token to the current one and bails if they
  // differ, rather than pressing on to open a socket that's already stale —
  // or, worse, reopening a socket the user just explicitly tore down. Same
  // pattern used in mediaProcessingQueue.ts.
  private connectGeneration: number = 0

  // Zustand subscription — fires when Zustand backend_url changes so we can
  // proactively tear down the old WS and reconnect to the new backend.
  // Without this, a Zustand update without a corresponding ws.connect() call
  // would leave WSM on the old URL until the next reconnect trigger (ping
  // timeout, server close, NO_ACTIVE_SESSION). See 101 for the bug that
  // pattern produced.
  private backendUrlUnsub: (() => void) | null = null

  private constructor() {
    super()
    GlobalEventEmitter.on("NO_ACTIVE_SESSION", this.handleNoActiveSession)

    // React to backend URL changes from the settings store. Any code path
    // that calls setSetting(backend_url, newUrl) — dev settings screen,
    // reset flows, programmatic override — triggers this handler and we
    // cleanly switch to the new backend. The handler reads the current
    // URL via getWsUrl() rather than trusting the selector's `newValue`,
    // so it always lines up with getRestUrl() (both share backend_url).
    this.backendUrlUnsub = useSettingsStore.subscribe(
      (state) => state.getSetting(SETTINGS.backend_url.key) as string | undefined,
      (newBackendUrl, prevBackendUrl) => {
        if (!newBackendUrl || newBackendUrl === prevBackendUrl) return
        this.handleBackendUrlChanged(newBackendUrl, prevBackendUrl)
      },
    )
  }

  /**
   * React to a backend_url Zustand change: if we have credentials to connect
   * with, disconnect cleanly from the old backend and reconnect to the new
   * one. If we do not have a token yet (app is booting before auth), just
   * leave the WSM idle — the first connect() will pick up the new URL
   * naturally.
   */
  private handleBackendUrlChanged(newBackendUrl: string, prevBackendUrl: string | undefined): void {
    const currentStoreUrl = useConnectionStore.getState().url
    console.log(
      `WSM: backend_url changed ${prevBackendUrl ?? "(unset)"} → ${newBackendUrl} (WS currently pointed at ${currentStoreUrl ?? "(none)"})`,
    )

    if (this.manuallyDisconnected) {
      // If the caller explicitly disconnected, trust that. The next
      // connect() call will read the fresh URL.
      return
    }

    if (!this.coreToken) {
      // No auth yet — nothing to reconnect with. The next connect() call
      // from mantle.init() will pick up the new URL.
      return
    }

    // Schedule a reconnect on a microtask so we don't hold up the Zustand
    // set() caller. The reconnect path (connect() → detachAndCloseSocket →
    // new WebSocket) is fully async inside.
    void this.reconnectNow(`backend_url changed to ${newBackendUrl}`)
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

  /**
   * Read the current WebSocket URL from the settings store.
   *
   * We deliberately do NOT cache this as a field. Before issue 101 the WSM
   * cached `this.url` at the last connect() call, which diverged from the
   * Zustand `backend_url` setting any time it was changed without a full
   * `mantle.cleanup() → mantle.init()` cycle. axios reads the URL fresh per
   * request via getRestUrl(), so REST would follow the new backend while the
   * WS kept reconnecting to the old one — producing a 90-opens-per-minute
   * reconnect storm when combined with PR #2565's retry-on-503 logic.
   * See: cloud/issues/101-mobile-ws-reconnect-storm/
   */
  private getCurrentWsUrl(): string | null {
    try {
      return useSettingsStore.getState().getWsUrl()
    } catch (error) {
      console.log("WSM: Failed to read WS URL from settings store:", error)
      return null
    }
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

  /**
   * Detach handlers from the current WebSocket, close it, and wait for the
   * actual close to fire before returning (up to CLOSE_WAIT_TIMEOUT_MS).
   *
   * Why await: connect() calls `new WebSocket(...)` immediately after tearing
   * down the old socket. Without waiting, the cloud briefly sees two active
   * sockets for the same user — it handles this by logging "stale — newer
   * WebSocket already active, ignoring" on the old socket, but the overlap
   * still costs both sides work and pollutes the logs.
   *
   * Why we null the attribute-style handlers after installing the one-shot
   * close listener: the attribute handlers could fire stale reconnect paths
   * on the old socket's close event. The one-shot listener only resolves the
   * wait promise, and its own null assignment below happens after the wait.
   */
  private async detachAndCloseSocket(): Promise<void> {
    const sock = this.webSocket
    if (!sock) return

    // Drop our reference first so anything else that checks this.webSocket
    // during the wait treats us as "no socket" — important for onerror/onclose
    // handlers that fire during the wait and would otherwise start a new
    // reconnect interval on an already-being-closed socket.
    this.webSocket = null

    const closePromise = new Promise<void>((resolve) => {
      sock.onclose = () => resolve()
      sock.onerror = () => resolve()
    })

    sock.onmessage = null
    sock.onopen = null

    try {
      sock.close()
    } catch {
      // Swallow — we're already tearing down. Native close will still fire.
    }

    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => BackgroundTimer.setTimeout(resolve, CLOSE_WAIT_TIMEOUT_MS)),
    ])

    // Null after wait so the one-shot handlers don't retain the socket.
    sock.onclose = null
    sock.onerror = null
  }

  /**
   * Connect (or reconnect) the WebSocket using the current backend URL from
   * the settings store.
   *
   * The `url` parameter is deprecated and ignored — it only exists so the
   * existing caller signature (socketComms.connectWebsocket) doesn't need
   * changing in this PR. The URL is always read fresh from
   * useSettingsStore.getWsUrl(). If you pass a URL argument that differs from
   * the current setting, we log a warning and still use the setting.
   */
  public async connect(_urlDeprecated: string | null | undefined, coreToken: string): Promise<void> {
    // A connect() call is an explicit intent to be online — clear any prior
    // manual-disconnect flag. Doing this here (not inside performConnect)
    // means a later disconnect() that runs while our attempt is still
    // queued can set manuallyDisconnected=true and have the queued attempt
    // observe it after its await, rather than our attempt clobbering that
    // signal back to false when it finally gets its turn.
    this.manuallyDisconnected = false
    this.coreToken = coreToken

    // Claim a generation now so that if a newer connect() or a disconnect()
    // fires before our turn on the chain, performConnect sees the bump and
    // bails out instead of opening a socket that's already stale.
    const myGeneration = ++this.connectGeneration

    // Append onto the chain tail: every caller waits for the current attempt
    // to finish before running its own. One performConnect body at a time,
    // no matter how many callers pile up.
    const run = this.connectChain
      .catch(() => {
        // Swallow the prior attempt's failure — each attempt is independent.
      })
      .then(() => this.performConnect(_urlDeprecated, coreToken, myGeneration))
    this.connectChain = run
    await run
  }

  private async performConnect(
    _urlDeprecated: string | null | undefined,
    coreToken: string,
    myGeneration: number,
  ): Promise<void> {
    // Superseded before we even started (a newer connect() was queued after
    // us, or disconnect() bumped the generation while we waited our turn):
    // skip the whole attempt — no teardown, no new socket.
    if (this.connectGeneration !== myGeneration) {
      console.log(`WSM: connect gen ${myGeneration} superseded before start, skipping`)
      return
    }
    if (this.manuallyDisconnected) {
      console.log(`WSM: connect gen ${myGeneration} cancelled by disconnect before start, skipping`)
      return
    }

    const url = this.getCurrentWsUrl()
    if (!url) {
      console.error("WSM: connect(): no backend URL available in settings store")
      return
    }
    if (_urlDeprecated && _urlDeprecated !== url) {
      console.log(
        `WSM: connect() called with URL argument ${_urlDeprecated} but settings store has ${url} — using settings store.`,
      )
    }
    console.log(`WSM: connect: ${url}`)

    // Tear down any existing connection cleanly BEFORE opening the new one,
    // so the cloud never sees two active sockets for the same user.
    this.stopLivenessMonitor()
    await this.detachAndCloseSocket()

    // Re-check after the awaited teardown: disconnect() or a newer connect()
    // may have fired during the up-to-500ms close wait. Opening a socket
    // past either of those is exactly the race called out in PR review — a
    // logout would be undone, or a stale URL's socket would race the new
    // one. Bail here instead.
    if (this.connectGeneration !== myGeneration) {
      console.log(`WSM: connect gen ${myGeneration} superseded during teardown, skipping`)
      return
    }
    if (this.manuallyDisconnected) {
      console.log(`WSM: connect gen ${myGeneration} cancelled by disconnect during teardown, skipping`)
      return
    }

    // Update status and record the URL in the connection store for observability.
    this.updateStatus(WebSocketStatus.CONNECTING)
    const store = useConnectionStore.getState()
    store.setUrl(url)

    // Attach auth and feature flags as query params.
    const wsUrl = new URL(url)
    wsUrl.searchParams.set("token", coreToken)
    wsUrl.searchParams.set("livekit", "true")
    wsUrl.searchParams.set("udpEncryption", "true")

    console.log("WSM: Connecting to WebSocket URL:", wsUrl.toString().replace(/token=[^&]+/, "token=REDACTED"))

    this.webSocket = new WebSocket(wsUrl.toString())
    this.installWebSocketHandlers()
  }

  private installWebSocketHandlers() {
    if (!this.webSocket) return
    const store = useConnectionStore.getState()

    this.webSocket.onopen = () => {
      console.log("WSM: WebSocket connection established")
      this.updateStatus(WebSocketStatus.CONNECTED)
      this.startLivenessMonitor()
    }

    this.webSocket.onmessage = (event) => {
      this.handleIncomingMessage(event.data)
    }

    this.webSocket.onerror = (error) => {
      console.log("WSM: WebSocket error:", error)
      this.stopLivenessMonitor()
      this.updateStatus(WebSocketStatus.ERROR)
      store.setError(error?.toString() || "WebSocket error")
      this.startReconnectInterval()
    }

    this.webSocket.onclose = (event) => {
      console.log("WSM: Connection closed with code:", event.code)
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
      if (this.coreToken) {
        // URL is always read fresh inside connect().
        void this.connect(null, this.coreToken)
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

  private async reconnectNow(reason: string): Promise<void> {
    console.log(`WSM: Immediate reconnect requested: ${reason}`)
    if (this.manuallyDisconnected) {
      return
    }

    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    if (this.coreToken) {
      // connect() handles its own teardown + URL read from settings.
      await this.connect(null, this.coreToken)
      return
    }

    this.startReconnectInterval()
  }

  private handleNoActiveSession = () => {
    if (this.previousStatus === WebSocketStatus.CONNECTING) {
      return
    }

    void this.reconnectNow("REST request returned NO_ACTIVE_SESSION")
  }

  public async disconnect(): Promise<void> {
    this.manuallyDisconnected = true
    // Bump so any in-flight performConnect currently awaiting
    // detachAndCloseSocket() — or any queued attempt still waiting its turn
    // on the connect chain — sees the generation change and bails out
    // instead of opening a fresh socket right after we tore one down.
    this.connectGeneration++

    if (this.reconnectInterval) {
      BackgroundTimer.clearInterval(this.reconnectInterval)
      this.reconnectInterval = 0
    }

    this.stopLivenessMonitor()
    await this.detachAndCloseSocket()
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
          void this.reconnectNow(`pong timeout after ${elapsed}ms`)
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

  public async cleanup(): Promise<void> {
    console.log("WSM: cleanup()")
    // Note: we intentionally do NOT unsubscribe backendUrlUnsub here.
    // WSM is a process-wide singleton and the constructor subscription is
    // never recreated. Any later ws.cleanup() path (e.g. the dev "Clear
    // Websocket" flow or mantle.cleanup()) would permanently disable
    // backend_url reactivity for the rest of the session and let REST and
    // WS diverge again (the bug this PR is fixing). The subscription is
    // cheap; let it live for the process.
    await this.disconnect()
    this.webSocket = null
    const store = useConnectionStore.getState()
    store.reset()
  }
}

const wsManager = WebSocketManager.getInstance()
export default wsManager
