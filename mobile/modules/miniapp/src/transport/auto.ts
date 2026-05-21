/**
 * @fileoverview Auto-detect the right Transport based on environment.
 */

import {LocalSocketTransport, LocalSocketTransportOptions} from "./local-socket"
import {MockTransport, isMockExplicitlyRequested} from "./mock"
import {PostMessageTransport} from "./postmessage"
import {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./types"

const LOCAL_SOCKET_OPEN_TIMEOUT_MS = 500

export interface CreateTransportOptions {
  /** Force a specific transport. Skip auto-detection. */
  transport?: Transport
  /** For LocalSocketTransport fallback — override the ws URL. */
  localSocketUrl?: string
}

/**
 * Return a Transport appropriate for the current environment.
 *
 * - Inside a MentraOS WebView (window.ReactNativeWebView defined): PostMessageTransport.
 * - In an external browser with explicit opt-in (`?mentra=mock` or
 *   `localStorage.MENTRA_MOCK=1`): MockTransport.
 * - In an external browser otherwise: a wrapper that races LocalSocketTransport
 *   open against a 500ms timeout, falling back to MockTransport on failure so the
 *   miniapp doesn't hang waiting for a phone-side WebSocket that isn't there.
 * - In an environment with no WebSocket global at all: MockTransport.
 */
export function createTransport(options: CreateTransportOptions = {}): Transport {
  if (options.transport) return options.transport

  if (typeof window !== "undefined" && window.ReactNativeWebView) {
    return new PostMessageTransport()
  }

  // Explicit opt-in to mock — useful for stories / framework-level testing.
  if (isMockExplicitlyRequested()) {
    return new MockTransport()
  }

  if (typeof WebSocket !== "undefined") {
    const localSocketOptions: LocalSocketTransportOptions = {}
    if (options.localSocketUrl) localSocketOptions.url = options.localSocketUrl
    return new LocalSocketWithMockFallback(localSocketOptions)
  }

  // No WebSocket at all (some embedded contexts, jsdom without a polyfill).
  // MockTransport keeps the SDK from throwing during construction.
  return new MockTransport()
}

/**
 * Internal wrapper transport: tries LocalSocketTransport first; if open() hasn't
 * resolved within LOCAL_SOCKET_OPEN_TIMEOUT_MS, swaps in MockTransport so a
 * miniapp opened in a regular browser tab gets a synthetic CONNECT_ACK instead
 * of a 10-second hang while the SDK's CONNECT_ACK timeout expires.
 *
 * Once a delegate is selected, all subsequent calls forward to it.
 */
class LocalSocketWithMockFallback implements Transport {
  private active: Transport | null = null
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null

  constructor(private readonly options: LocalSocketTransportOptions) {}

  async open(): Promise<void> {
    const local = new LocalSocketTransport(this.options)
    let timedOut = false
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => {
        timedOut = true
        reject(new Error("LocalSocketTransport open timed out"))
      }, LOCAL_SOCKET_OPEN_TIMEOUT_MS)
    })

    try {
      await Promise.race([local.open(), timeout])
      // LocalSocket succeeded.
      this.active = local
    } catch {
      try {
        local.close()
      } catch {
        /* ignore */
      }
      const mock = new MockTransport()
      await mock.open()
      this.active = mock
      // eslint-disable-next-line no-console
      console.log(
        timedOut
          ? "[mentra-miniapp] No phone WebSocket reachable; using MockTransport so the page can render."
          : "[mentra-miniapp] LocalSocketTransport failed; using MockTransport.",
      )
    }

    if (this.messageHandler) this.active.onMessage(this.messageHandler)
    if (this.disconnectHandler) this.active.onDisconnect(this.disconnectHandler)
  }

  send(raw: string): void {
    if (!this.active) throw new Error("LocalSocketWithMockFallback: send() before open()")
    this.active.send(raw)
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
    this.active?.onMessage(handler)
  }

  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
    this.active?.onDisconnect(handler)
  }

  close(): void {
    this.active?.close()
  }

  isOpen(): boolean {
    return this.active?.isOpen() === true
  }
}
