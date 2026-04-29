/**
 * @fileoverview MockTransport — browser-tab fallback so the SDK doesn't hang.
 *
 * Activates when:
 *   - `window.ReactNativeWebView` is undefined (not in MentraOS WebView), AND
 *   - The first LocalSocketTransport connection attempt fails fast, OR
 *   - The author opts in via `?mentra=mock` query param / `localStorage.MENTRA_MOCK = "1"`.
 *
 * Behaviors:
 *   - On `open()`: synthesize a CONNECT_ACK envelope so `session.connect()` resolves.
 *   - On `send(envelope)`: parse, log to console with `[mock-transport]` prefix,
 *     auto-reply with synthetic results for any request that needs one.
 *   - Does NOT emit any glasses events. Subscribing succeeds silently.
 *
 * This is the Stage-1 stopgap from `agents/miniapp-quick-fixes-spec.md` #6.
 * The full simulator (event injection, glasses-display preview, hardware bridge)
 * is Stage 2 — see `agents/miniapp-browser-testing-simulator-spec.md`.
 */

import {parseEnvelope, serializeEnvelope, type MiniappEnvelope} from "../envelope"
import {MiniappRequestType, MiniappResponseType} from "../protocol"
import type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./types"

const LOG_PREFIX = "[mock-transport]"

/**
 * Returns true if the current environment requested the mock transport
 * explicitly. Checks `?mentra=mock` query param and `localStorage.MENTRA_MOCK`.
 */
export function isMockExplicitlyRequested(): boolean {
  if (typeof window === "undefined") return false
  try {
    if (typeof window.location !== "undefined" && window.location.search) {
      const params = new URLSearchParams(window.location.search)
      if (params.get("mentra") === "mock") return true
    }
  } catch {
    // ignore
  }
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("MENTRA_MOCK") === "1") {
      return true
    }
  } catch {
    // localStorage may throw in some embedded contexts; ignore
  }
  return false
}

export interface MockTransportOptions {
  /** Override the synthetic userId. Default "mock-user". */
  userId?: string
  /** Override the synthetic packageName when window.MentraOS isn't set. */
  packageName?: string
  /** Suppress the [mock-transport] console logs. Default false. */
  silent?: boolean
}

export class MockTransport implements Transport {
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null
  private open_ = false
  private readonly userId: string
  private readonly packageName: string | null
  private readonly silent: boolean

  constructor(options: MockTransportOptions = {}) {
    this.userId = options.userId ?? "mock-user"
    this.packageName = options.packageName ?? null
    this.silent = options.silent === true
  }

  async open(): Promise<void> {
    if (this.open_) return
    this.open_ = true
    this.log("transport opened (no real host; synthetic responses only)")
  }

  send(raw: string): void {
    if (!this.open_) {
      throw new Error("MockTransport: send() before open()")
    }
    const envelope = parseEnvelope(raw)
    if (!envelope) {
      this.log("dropped unparseable envelope:", raw.slice(0, 200))
      return
    }
    const payload = envelope.payload as {type?: string} & Record<string, unknown>
    const type = payload?.type
    this.log(`recv ${type ?? "<unknown>"}${envelope.requestId ? ` (rid=${envelope.requestId})` : ""}`)

    // Handle the protocol's synchronous handshake/responses.
    switch (type) {
      case MiniappRequestType.CONNECT:
        this.deliverConnectAck(payload)
        return

      case MiniappRequestType.PING:
        // Real phone sends PING. We never do — but if app code somehow does,
        // ignore it. The SDK auto-replies to inbound PINGs, not vice versa.
        return

      case MiniappRequestType.SUBSCRIBE:
        // Subscribe is fire-and-forget; no response expected. Stage 1 emits no
        // events. Future Stage 2 simulator can synthesize events here.
        return

      default:
        // Anything that has a requestId expects a REQUEST_RESULT. Reply with a
        // synthetic empty success so app code that awaits the promise resolves.
        if (envelope.requestId) {
          this.deliverSyntheticResult(envelope.requestId, type ?? "<unknown>")
        }
        return
    }
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    this.disconnectHandler?.("MockTransport.close()")
  }

  isOpen(): boolean {
    return this.open_
  }

  // ---------------------------------------------------------------------------

  private deliverConnectAck(connectPayload: Record<string, unknown>): void {
    const incomingPackage = (connectPayload.packageName as string | undefined) ?? this.packageName ?? "com.mock.app"
    const ackPayload = {
      type: MiniappResponseType.CONNECT_ACK,
      userId: this.userId,
      packageName: incomingPackage,
      capabilities: null,
      visibility: "foreground",
      colorScheme: "light",
    }
    const envelope: MiniappEnvelope = {payload: ackPayload}
    this.log(`-> CONNECT_ACK userId=${this.userId} pkg=${incomingPackage}`)
    // Deliver asynchronously so it doesn't fire during the same tick as send().
    queueMicrotask(() => this.messageHandler?.(serializeEnvelope(envelope)))
  }

  private deliverSyntheticResult(requestId: string, requestType: string): void {
    const data = syntheticDataFor(requestType)
    const responsePayload = {
      type: MiniappResponseType.REQUEST_RESULT,
      ok: true,
      data,
    }
    const envelope: MiniappEnvelope = {payload: responsePayload, requestId}
    this.log(`-> REQUEST_RESULT (rid=${requestId}) synthetic ${requestType}`)
    queueMicrotask(() => this.messageHandler?.(serializeEnvelope(envelope)))
  }

  private log(...args: unknown[]): void {
    if (this.silent) return
    // eslint-disable-next-line no-console
    console.log(LOG_PREFIX, ...args)
  }
}

/**
 * Synthetic payload for an unrecognized request that nonetheless awaits a
 * REQUEST_RESULT. Returns enough shape to satisfy callers without crashing.
 */
function syntheticDataFor(requestType: string): unknown {
  switch (requestType) {
    case MiniappRequestType.PHOTO:
      // 1×1 transparent PNG so consumers that try to render don't 404.
      return {
        photoUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        requestId: "mock-photo",
      }

    case MiniappRequestType.LOCATION_POLL:
      return {lat: 0, lng: 0, accuracy: 0, timestamp: Date.now()}

    case MiniappRequestType.STORAGE_GET:
      return {value: null}

    case MiniappRequestType.STORAGE_LIST:
      return {keys: []}

    case MiniappRequestType.SPEAK:
      return {audioUrl: null, durationMs: 0}

    case MiniappRequestType.SHARE:
    case MiniappRequestType.OPEN_URL:
    case MiniappRequestType.COPY_CLIPBOARD:
    case MiniappRequestType.DOWNLOAD:
      return {ok: true}

    default:
      return null
  }
}
