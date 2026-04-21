/**
 * WebSocketTransport
 *
 * Transport implementation that wraps the `ws` library for cloud/server apps.
 * Used by MentraApp to connect MentraSession instances to the cloud.
 *
 * This is the ONLY file in the SDK that imports `ws` — the session layer
 * and all managers are transport-agnostic and never touch WebSocket directly.
 *
 * @example
 * ```ts
 * const transport = new WebSocketTransport("wss://cloud.mentra.glass/ws/miniapp", {
 *   headers: { Authorization: `Bearer ${jwt}` },
 *   timeoutMs: 10000,
 * });
 *
 * transport.onMessage((data) => console.log("received:", data));
 * transport.onClose((code, reason) => console.log("closed:", code, reason));
 *
 * await transport.connect();
 * transport.send(JSON.stringify({ type: "connection_init", ... }));
 * ```
 */

import { WebSocket } from "ws";
import { Transport, TransportState, TransportOptions } from "./Transport";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface WebSocketTransportOptions extends TransportOptions {
  /** WebSocket URL to connect to (wss:// or ws://) */
  url: string;

  /** Headers sent during the WebSocket upgrade request */
  headers?: Record<string, string>;

  /** Connection timeout in milliseconds (default: 10000) */
  timeoutMs?: number;

  /**
   * If true, the transport will attempt to connect immediately on construction.
   * If false (default), call connect() manually.
   */
  connectOnCreate?: boolean;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private _readyState: TransportState = TransportState.CLOSED;

  // Handler slots — only one handler per event type (last registration wins)
  private _onMessage: ((data: string) => void) | null = null;
  private _onBinary: ((data: ArrayBuffer) => void) | null = null;
  private _onClose: ((code: number, reason: string) => void) | null = null;
  private _onError: ((error: Error) => void) | null = null;

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: WebSocketTransportOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 10000;

    if (options.connectOnCreate) {
      this.connect();
    }
  }

  // ─── Transport Interface ────────────────────────────────────────────────

  get readyState(): TransportState {
    // Prefer the real WebSocket readyState if available
    if (this.ws) {
      return this.ws.readyState as TransportState;
    }
    return this._readyState;
  }

  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Silently drop — callers should check readyState if they care
      return;
    }
    try {
      this.ws.send(data);
    } catch {
      // Send failures on a closing socket are expected; swallow them
    }
  }

  sendBinary(data: ArrayBuffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(data);
    } catch {
      // Swallow send errors on closing sockets
    }
  }

  onMessage(handler: (data: string) => void): void {
    this._onMessage = handler;
  }

  onBinary(handler: (data: ArrayBuffer) => void): void {
    this._onBinary = handler;
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this._onClose = handler;
  }

  onError(handler: (error: Error) => void): void {
    this._onError = handler;
  }

  close(code?: number, reason?: string): void {
    if (!this.ws) {
      this._readyState = TransportState.CLOSED;
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this._readyState = TransportState.CLOSING;
      try {
        this.ws.close(code ?? 1000, reason ?? "");
      } catch {
        // Already closing or closed
        this._readyState = TransportState.CLOSED;
      }
    }
  }

  // ─── Connection Management ──────────────────────────────────────────────

  /**
   * Establish the WebSocket connection.
   * Resolves when the connection is open, rejects on error or timeout.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.ws) {
        // Clean up previous connection
        this.detachListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          try {
            this.ws.close();
          } catch {
            // Ignore
          }
        }
        this.ws = null;
      }

      this._readyState = TransportState.CONNECTING;

      // Connection timeout
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._readyState = TransportState.CLOSED;
          if (this.ws) {
            try {
              this.ws.close();
            } catch {
              // Ignore
            }
          }
          reject(new Error(`WebSocket connection timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      try {
        this.ws = new WebSocket(this.url, {
          headers: this.headers,
        });

        // Handle binary data as ArrayBuffer (not Buffer)
        this.ws.binaryType = "arraybuffer";

        this.ws.addEventListener("open", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this._readyState = TransportState.OPEN;
            resolve();
          }
        });

        this.ws.addEventListener("message", (event) => {
          this.handleIncomingMessage(event.data);
        });

        this.ws.addEventListener("close", (event) => {
          this._readyState = TransportState.CLOSED;

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`WebSocket closed before open: code=${event.code} reason=${event.reason}`));
          }

          if (this._onClose) {
            try {
              this._onClose(event.code, event.reason || "");
            } catch {
              // Don't let handler errors propagate
            }
          }
        });

        this.ws.addEventListener("error", (event) => {
          const error = event instanceof Error ? event : new Error("WebSocket error");

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this._readyState = TransportState.CLOSED;
            reject(error);
          }

          if (this._onError) {
            try {
              this._onError(error);
            } catch {
              // Don't let handler errors propagate
            }
          }
        });
      } catch (err) {
        settled = true;
        clearTimeout(timeout);
        this._readyState = TransportState.CLOSED;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Whether the transport is currently connected and ready to send.
   */
  get isOpen(): boolean {
    return this.readyState === TransportState.OPEN;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private handleIncomingMessage(data: unknown): void {
    // Binary message (ArrayBuffer from binaryType: "arraybuffer")
    if (data instanceof ArrayBuffer) {
      if (this._onBinary) {
        try {
          this._onBinary(data);
        } catch {
          // Don't let handler errors kill the transport
        }
      }
      return;
    }

    // Node Buffer (ws may deliver Buffer even with binaryType: "arraybuffer" in some paths)
    if (Buffer.isBuffer(data)) {
      if (this._onBinary) {
        const ab = new Uint8Array(data).slice().buffer;
        try {
          this._onBinary(ab);
        } catch {
          // Swallow handler errors
        }
      }
      return;
    }

    // Text message
    if (typeof data === "string") {
      if (this._onMessage) {
        try {
          this._onMessage(data);
        } catch {
          // Swallow handler errors
        }
      }
      return;
    }

    // Blob (unlikely in Node/Bun, but handle defensively)
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      // Convert Blob to text — async but necessary
      data.text().then((text) => {
        if (this._onMessage) {
          try {
            this._onMessage(text);
          } catch {
            // Swallow handler errors
          }
        }
      });
      return;
    }

    // Unknown type — try to stringify
    if (this._onMessage) {
      try {
        this._onMessage(String(data));
      } catch {
        // Swallow handler errors
      }
    }
  }

  /**
   * Remove all event listeners from the current WebSocket instance.
   * Called before replacing the socket on reconnect.
   */
  private detachListeners(): void {
    if (this.ws) {
      // Remove all listeners to prevent memory leaks.
      // The `ws` library supports removeAllListeners().
      try {
        this.ws.removeAllListeners();
      } catch {
        // Some environments may not support removeAllListeners
      }
    }
  }
}
