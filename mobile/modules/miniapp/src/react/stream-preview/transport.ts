/**
 * The two ways raw frames reach this WebView, behind one interface.
 *
 * iOS has no way to hand a WebView binary without a copy through JavaScriptCore, so it gets a
 * loopback WebSocket. Android has `WebViewCompat.addWebMessageListener`, which delivers an
 * ArrayBuffer to a JS object the native side installs on `window`. Which one is in use is decided
 * by the host's config, never by the page.
 *
 * Reconnection is not here. Every failure is surfaced with its own reason and `PreviewConnection`
 * decides whether to handshake again.
 */

import {previewTrace, previewTraceWarn} from "./trace"

export interface PreviewTransport {
  connect(): Promise<void>
  onBinary(cb: (buf: ArrayBuffer) => void): void
  onError(cb: (reason: string) => void): void
  sendText(json: string): void
  close(): void
}

/** Carries the machine-readable reason so a caller does not have to match on message text. */
export class PreviewTransportError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = "PreviewTransportError"
    this.reason = reason
  }
}

/** The Android-side object installed by `WebViewCompat.addWebMessageListener`. */
export interface PreviewWebMessagePort {
  postMessage(message: string): void
  addEventListener(type: "message", handler: (event: {data: unknown}) => void): void
  removeEventListener?(type: "message", handler: (event: {data: unknown}) => void): void
}

/** Used when an older host config omits `portName`. */
export const DEFAULT_PREVIEW_PORT_NAME = "MentraFramePreviewPort"

/** `{t:"ack",gen,seq}` — the one message the consumer sends per frame. */
export function ackMessage(gen: number, seq: number): string {
  return JSON.stringify({t: "ack", gen, seq})
}

function helloMessage(token: string): string {
  return JSON.stringify({t: "hello", token})
}

/** iOS: a loopback WebSocket from the native host. */
export class WebSocketTransport implements PreviewTransport {
  private socket: WebSocket | null = null
  private binaryHandler: ((buf: ArrayBuffer) => void) | null = null
  private errorHandler: ((reason: string) => void) | null = null
  private opened = false
  private closed = false

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(this.url)
      } catch (error) {
        previewTraceWarn("transport_error", {
          transport: "websocket",
          reason: "websocket_unavailable",
          error: error instanceof Error ? error.message : String(error),
        })
        reject(new PreviewTransportError("websocket_unavailable"))
        return
      }
      socket.binaryType = "arraybuffer"
      this.socket = socket
      socket.onopen = () => {
        this.opened = true
        try {
          // `connect()` must not resolve before the host knows who we are, or the first frames
          // would race the hello and be dropped by the sender as unauthenticated.
          socket.send(helloMessage(this.token))
        } catch {
          this.fail("hello_send_failed")
          reject(new PreviewTransportError("hello_send_failed"))
          return
        }
        previewTrace("transport_open", {transport: "websocket"})
        resolve()
      }
      socket.onmessage = (event: MessageEvent) => {
        // Text frames are not this channel: control lives on the `_preview` UI channel.
        if (event.data instanceof ArrayBuffer) this.binaryHandler?.(event.data)
      }
      socket.onerror = () => {
        const reason = this.opened ? "websocket_error" : "websocket_connect_error"
        this.fail(reason)
        if (!this.opened) reject(new PreviewTransportError(reason))
      }
      socket.onclose = (event: CloseEvent) => {
        const reason = this.opened ? `websocket_closed:${event.code}` : `websocket_closed_before_open:${event.code}`
        this.fail(reason)
        if (!this.opened) reject(new PreviewTransportError(reason))
      }
    })
  }

  onBinary(cb: (buf: ArrayBuffer) => void): void {
    this.binaryHandler = cb
  }

  onError(cb: (reason: string) => void): void {
    this.errorHandler = cb
  }

  sendText(json: string): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.fail("send_while_closed")
      return
    }
    try {
      socket.send(json)
    } catch {
      this.fail("send_failed")
    }
  }

  close(): void {
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close()
    } catch {
      // A socket that never opened throws here on some engines; the transport is gone either way.
    }
  }

  private fail(reason: string): void {
    // A close the caller asked for is not a failure.
    if (this.closed) return
    this.errorHandler?.(reason)
  }
}

/** Android: the JS object native installs with `WebViewCompat.addWebMessageListener`. */
export class WebMessagePortTransport implements PreviewTransport {
  private port: PreviewWebMessagePort | null = null
  private binaryHandler: ((buf: ArrayBuffer) => void) | null = null
  private errorHandler: ((reason: string) => void) | null = null
  private closed = false
  private readonly listener = (event: {data: unknown}) => {
    if (event.data instanceof ArrayBuffer) {
      this.binaryHandler?.(event.data)
      return
    }
    if (typeof event.data !== "string") this.report("port_unexpected_payload")
  }

  constructor(
    private readonly token: string,
    private readonly portName: string = DEFAULT_PREVIEW_PORT_NAME,
  ) {}

  connect(): Promise<void> {
    const port =
      typeof window === "undefined"
        ? undefined
        : ((window as unknown as Record<string, unknown>)[this.portName] as PreviewWebMessagePort | undefined)
    if (!port) return Promise.reject(new PreviewTransportError("port_missing"))
    this.port = port
    port.addEventListener("message", this.listener)
    try {
      port.postMessage(helloMessage(this.token))
    } catch {
      return Promise.reject(new PreviewTransportError("hello_send_failed"))
    }
    previewTrace("transport_open", {transport: "webmessage"})
    return Promise.resolve()
  }

  onBinary(cb: (buf: ArrayBuffer) => void): void {
    this.binaryHandler = cb
  }

  onError(cb: (reason: string) => void): void {
    this.errorHandler = cb
  }

  sendText(json: string): void {
    const port = this.port
    if (!port) {
      this.report("send_while_closed")
      return
    }
    try {
      port.postMessage(json)
    } catch {
      this.report("send_failed")
    }
  }

  close(): void {
    this.closed = true
    this.port?.removeEventListener?.("message", this.listener)
    this.port = null
  }

  private report(reason: string): void {
    if (this.closed) return
    this.errorHandler?.(reason)
  }
}

export interface PreviewTransportOptions {
  url?: string
  portName?: string
  token: string
}

/** Build the transport the host asked for. The page never picks on its own. */
export function createPreviewTransport(
  transport: "websocket" | "webmessage",
  options: PreviewTransportOptions,
): PreviewTransport {
  if (transport === "websocket") {
    if (!options.url) throw new PreviewTransportError("missing_url")
    return new WebSocketTransport(options.url, options.token)
  }
  return new WebMessagePortTransport(options.token, options.portName)
}
