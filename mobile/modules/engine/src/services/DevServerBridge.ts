/**
 * DevServerBridge — phone-side WebSocket connection to a `mentra-miniapp dev`
 * sidecar running on a developer's laptop.
 *
 * Multiplexed over a single WebSocket per dev miniapp:
 *   laptop → phone : {type: "reload"}                 → trigger WebView.reload()
 *   phone  → laptop: {type: "log", level, args, ...}  → forwarded console calls
 *
 * Lifecycle: `connect(packageName, devUrl, devPort)` is called from
 * MiniappHost.mountDev once the dev applet is mounted. `disconnect(packageName)`
 * is called from MiniappHost.unmount. Reconnect with exponential backoff on
 * unexpected close — the dev server is the developer's laptop and may bounce.
 *
 * Outgoing logs are buffered in a small ring while disconnected; flushed on
 * reconnect. This catches early-startup logs the developer would otherwise
 * miss when re-launching the dev server.
 */

const LOG_TAG = "DEV_SERVER_BRIDGE"
const PROTOCOL_VERSION = "mentra-dev/1"
const HELLO_TIMEOUT_MS = 1_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const RING_BUFFER_MAX_ENTRIES = 100
const RING_BUFFER_MAX_BYTES = 32 * 1024

type State = "idle" | "connecting" | "connected" | "disconnected" | "closed"

interface BufferedLog {
  packageName: string
  level: string
  args: unknown[]
  timestamp: number
  /** "ui" = WebView, "background" = JSContext. Stamped at capture time. */
  source: "ui" | "background"
  size: number
}

interface BridgeEntry {
  state: State
  ws: WebSocket | null
  url: string
  attempts: number
  ringBuffer: BufferedLog[]
  ringBytes: number
  reloadHandler: ((packageName: string) => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

class DevServerBridge {
  private entries = new Map<string, BridgeEntry>()
  private globalReloadHandler: ((packageName: string) => void) | null = null
  private globalRespawnBackgroundHandler: ((packageName: string) => void) | null = null

  /**
   * Register a global reload handler. MiniappHost calls this once at boot. The
   * bridge invokes the handler with the offending packageName whenever a
   * reload signal is received.
   */
  public onReload(handler: (packageName: string) => void): void {
    this.globalReloadHandler = handler
  }

  /**
   * Register a global background-respawn handler. Fires when the dev
   * server sends `{type: "respawn-bg"}` — emitted on filesystem changes
   * under `src/background/`. The host (MentraJSRouter via the
   * bootstrap) should kill + respawn the JSContext to pick up the
   * change. WebView reload is separate (see `onReload`).
   */
  public onRespawnBackground(handler: ((packageName: string) => void) | null): void {
    this.globalRespawnBackgroundHandler = handler
  }

  /** Clear the background-respawn handler when the miniapp engine is stopped. */
  public clearRespawnBackgroundHandler(): void {
    this.globalRespawnBackgroundHandler = null
  }

  /** Open (or re-open) a bridge to the given dev server. */
  public connect(packageName: string, devHostUrl: string, devPort: number): void {
    const url = this.buildWsUrl(devHostUrl, devPort)
    let entry = this.entries.get(packageName)
    if (entry) {
      // Already have an entry; if the URL changed (e.g. LAN IP shifted), close
      // and rebuild.
      if (entry.url === url && (entry.state === "connecting" || entry.state === "connected")) return
      this.teardownEntry(entry)
    }
    entry = {
      state: "idle",
      ws: null,
      url,
      attempts: 0,
      ringBuffer: [],
      ringBytes: 0,
      reloadHandler: null,
      reconnectTimer: null,
    }
    this.entries.set(packageName, entry)
    this.openSocket(packageName, entry)
  }

  /** Close a bridge for good. Called from MiniappHost.unmount. */
  public disconnect(packageName: string): void {
    const entry = this.entries.get(packageName)
    if (!entry) return
    entry.state = "closed"
    this.teardownEntry(entry)
    this.entries.delete(packageName)
  }

  /**
   * Forward a `log` envelope to the connected dev sidecar. Called from
   * the JSContext side (`MentraJSRouter.__log` handler) AND the WebView
   * side (`MentraUIRouter.routeFromWebView` for `type:"log"` frames).
   *
   * `source` distinguishes the two halves so the CLI can prefix lines
   * `[UI]` vs `[MentraJS]`. Logs are silently dropped when no bridge
   * exists for the package (no `mentra-miniapp dev` running) and
   * buffered in the per-bridge ring while disconnected.
   */
  public forwardLog(
    packageName: string,
    level: string,
    args: unknown[],
    timestamp: number,
    source: "ui" | "background",
  ): void {
    const entry = this.entries.get(packageName)
    if (!entry) return
    const message = JSON.stringify({type: "log", level, args, packageName, timestamp, source})
    if (entry.state === "connected" && entry.ws) {
      try {
        entry.ws.send(message)
        return
      } catch {
        // Fall through to buffer.
      }
    }
    this.bufferLog(entry, {packageName, level, args, timestamp, source, size: message.length})
  }

  // -----------------------------------------------------------------------

  private buildWsUrl(devHostUrl: string, devPort: number): string {
    let host: string
    try {
      const parsed = new URL(devHostUrl)
      host = parsed.hostname
    } catch {
      // devHostUrl might already be just an IP; best-effort.
      host = devHostUrl.replace(/^https?:\/\//, "").split(":")[0].split("/")[0]
    }
    return `ws://${host}:${devPort}/__mentra_dev`
  }

  private openSocket(packageName: string, entry: BridgeEntry): void {
    if (entry.state === "closed") return
    entry.state = "connecting"
    const ws = new WebSocket(entry.url)
    entry.ws = ws

    let helloTimer: ReturnType<typeof setTimeout> | null = null
    let helloAcked = false

    const teardown = (reason: string): void => {
      if (helloTimer) {
        clearTimeout(helloTimer)
        helloTimer = null
      }
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (entry.state === "closed") return
      entry.state = "disconnected"
      entry.ws = null
      entry.attempts++
      console.log(`${LOG_TAG}: ${packageName} disconnected (${reason}); reconnect in ${this.backoffMs(entry.attempts)}ms`)
      this.scheduleReconnect(packageName, entry)
    }

    ws.onopen = () => {
      // Send hello; wait for hello-ack to confirm we hit the right server.
      try {
        ws.send(JSON.stringify({type: "hello", protocol: PROTOCOL_VERSION}))
      } catch {
        teardown("hello send failed")
        return
      }
      helloTimer = setTimeout(() => {
        if (!helloAcked) {
          teardown("hello-ack timeout")
        }
      }, HELLO_TIMEOUT_MS)
    }

    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : null
      if (!data) return
      let parsed: {type?: string; protocol?: string} | null = null
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (!parsed) return

      if (parsed.type === "hello-ack") {
        if (parsed.protocol !== PROTOCOL_VERSION) {
          teardown(`protocol mismatch: server sent ${parsed.protocol}, expected ${PROTOCOL_VERSION}`)
          return
        }
        helloAcked = true
        if (helloTimer) {
          clearTimeout(helloTimer)
          helloTimer = null
        }
        entry.state = "connected"
        entry.attempts = 0
        console.log(`${LOG_TAG}: ${packageName} connected to ${entry.url}`)
        this.flushRingBuffer(packageName, entry)
        return
      }

      if (parsed.type === "reload") {
        console.log(`${LOG_TAG}: ${packageName} received reload signal`)
        this.globalReloadHandler?.(packageName)
        return
      }

      // Two-layer dev signal: filesystem changes under src/background/
      // trigger a full JSContext kill + respawn (not just a WebView
      // reload). The host's MentraJSRouter listens here.
      if (parsed.type === "respawn-bg") {
        console.log(`${LOG_TAG}: ${packageName} received respawn-bg signal`)
        this.globalRespawnBackgroundHandler?.(packageName)
        return
      }
    }

    ws.onerror = () => {
      // onclose follows; defer all teardown to that path so we don't double-fire.
    }

    ws.onclose = () => {
      teardown(helloAcked ? "ws closed" : "ws closed before hello-ack")
    }
  }

  private scheduleReconnect(packageName: string, entry: BridgeEntry): void {
    if (entry.state === "closed") return
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    const delay = this.backoffMs(entry.attempts)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      // Verify still alive and still in the bridge map.
      const current = this.entries.get(packageName)
      if (!current || current !== entry || entry.state === "closed") return
      this.openSocket(packageName, entry)
    }, delay)
  }

  private backoffMs(attempts: number): number {
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, Math.max(0, attempts - 1)))
    const jitter = exp * (0.8 + Math.random() * 0.4)
    return Math.round(jitter)
  }

  private bufferLog(entry: BridgeEntry, log: BufferedLog): void {
    entry.ringBuffer.push(log)
    entry.ringBytes += log.size
    while (
      entry.ringBuffer.length > RING_BUFFER_MAX_ENTRIES ||
      entry.ringBytes > RING_BUFFER_MAX_BYTES
    ) {
      const dropped = entry.ringBuffer.shift()
      if (dropped) entry.ringBytes -= dropped.size
      if (entry.ringBuffer.length === 0) {
        entry.ringBytes = 0
        break
      }
    }
  }

  private flushRingBuffer(packageName: string, entry: BridgeEntry): void {
    if (entry.ringBuffer.length === 0) return
    const buffered = entry.ringBuffer
    entry.ringBuffer = []
    entry.ringBytes = 0
    if (!entry.ws) return
    for (const log of buffered) {
      try {
        entry.ws.send(
          JSON.stringify({
            type: "log",
            level: log.level,
            args: log.args,
            packageName: log.packageName,
            timestamp: log.timestamp,
            source: log.source,
          }),
        )
      } catch {
        // Re-buffer on failure and bail.
        entry.ringBuffer.unshift(log)
        entry.ringBytes += log.size
        return
      }
    }
  }

  private teardownEntry(entry: BridgeEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    if (entry.ws) {
      try {
        entry.ws.close()
      } catch {
        /* ignore */
      }
      entry.ws = null
    }
  }
}

const devServerBridge = new DevServerBridge()
export default devServerBridge
