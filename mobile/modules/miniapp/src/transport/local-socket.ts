/**
 * @fileoverview LocalSocket transport — browser fallback.
 *
 * When the miniapp runs in an external browser (Safari/Chrome, not inside the
 * MentraOS React Native WebView), it connects to a localhost WebSocket that
 * MentraOS exposes via MiniSockets (Phase 4 of the plan).
 *
 * Default endpoint: ws://127.0.0.1:8765. Override via the `url` option for
 * dev / testing.
 */

import {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./types"

export interface LocalSocketTransportOptions {
  url?: string
}

const DEFAULT_URL = "ws://127.0.0.1:8765"

export class LocalSocketTransport implements Transport {
  private url: string
  private ws: WebSocket | null = null
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null

  constructor(options: LocalSocketTransportOptions = {}) {
    this.url = options.url ?? DEFAULT_URL
  }

  async open(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    if (typeof WebSocket === "undefined") {
      throw new Error("LocalSocketTransport: browser WebSocket global not available")
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url)
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      ws.onopen = () => {
        this.ws = ws
        settle(() => resolve())
      }
      ws.onerror = (ev) => {
        settle(() =>
          reject(new Error(`LocalSocketTransport: failed to connect to ${this.url}: ${String(ev)}`)),
        )
      }
      ws.onmessage = (ev: MessageEvent) => {
        const data = ev.data
        if (typeof data === "string") this.messageHandler?.(data)
      }
      ws.onclose = (ev) => {
        if (this.ws === ws) this.ws = null
        this.disconnectHandler?.(`closed: ${ev.code} ${ev.reason}`)
      }
    })
  }

  send(raw: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("LocalSocketTransport: not connected")
    }
    this.ws.send(raw)
  }

  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }

  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
  }

  close(): void {
    if (!this.ws) return
    try {
      this.ws.close()
    } catch {
      // ignore
    }
    this.ws = null
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }
}
