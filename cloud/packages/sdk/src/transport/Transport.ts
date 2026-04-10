/**
 * Transport Interface
 *
 * Runtime-agnostic message transport contract for MentraSession.
 * On a cloud server, this is a WebSocket. On a phone, it's a native bridge.
 * In tests, it's a mock. MentraSession never imports WebSocket directly —
 * it receives a Transport from the host environment.
 *
 * This interface has ZERO Node.js/Bun/server dependencies.
 * It runs in any JS engine (V8, JSC, Hermes, QuickJS).
 *
 * @see WebSocketTransport — cloud/server implementation
 * @see NativeBridgeTransport — phone/local runtime implementation (future)
 */

// ─── Transport States ───────────────────────────────────────────────────────

/**
 * Transport connection states, mirroring WebSocket readyState values
 * for compatibility with existing code that checks readyState.
 */
export const TransportState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type TransportState = (typeof TransportState)[keyof typeof TransportState];

// ─── Transport Interface ────────────────────────────────────────────────────

/**
 * The Transport interface is the only bridge between MentraSession
 * and the outside world. Everything else (managers, message dispatch,
 * subscription logic) is pure TypeScript that runs identically
 * regardless of which Transport implementation is in use.
 *
 * Implementations:
 * - `WebSocketTransport` — wraps `ws` for cloud/server apps (used by MentraApp)
 * - `NativeBridgeTransport` — wraps `globalThis.__mentraTransport` for local apps
 * - `MockTransport` — for unit tests
 *
 * @example
 * ```ts
 * // Cloud app — MentraApp creates this automatically
 * const transport = new WebSocketTransport(wsUrl);
 *
 * // Local app — phone runtime provides this
 * const transport = new NativeBridgeTransport(globalThis.__mentraTransport);
 *
 * // Either way, MentraSession works the same
 * const session = new MentraSession({ transport, ... });
 * ```
 */
export interface Transport {
  /**
   * Send a JSON-serialized string message to the cloud/host.
   * Implementations should silently drop or queue messages
   * when the transport is not in OPEN state.
   */
  send(data: string): void;

  /**
   * Send binary data (e.g., audio stream frames).
   * Used by SpeakerManager for audio output streaming.
   */
  sendBinary(data: ArrayBuffer | Uint8Array): void;

  /**
   * Register a handler for incoming text (JSON) messages.
   * Only one handler should be active at a time — subsequent
   * calls replace the previous handler.
   */
  onMessage(handler: (data: string) => void): void;

  /**
   * Register a handler for incoming binary messages.
   * Used by MicManager for raw audio chunks.
   * Only one handler should be active at a time.
   */
  onBinary(handler: (data: ArrayBuffer) => void): void;

  /**
   * Register a handler for transport close events.
   * `code` and `reason` follow WebSocket close frame semantics.
   * Only one handler should be active at a time.
   */
  onClose(handler: (code: number, reason: string) => void): void;

  /**
   * Register a handler for transport errors.
   * Only one handler should be active at a time.
   */
  onError(handler: (error: Error) => void): void;

  /**
   * Close the transport. After calling this, no more messages
   * will be sent or received. The `onClose` handler will fire.
   */
  close(code?: number, reason?: string): void;

  /**
   * Current state of the transport.
   * Uses the same numeric values as WebSocket.readyState:
   *   0 = CONNECTING
   *   1 = OPEN
   *   2 = CLOSING
   *   3 = CLOSED
   */
  readonly readyState: TransportState;
}

// ─── Transport Events (for typed event patterns) ────────────────────────────

/**
 * Options passed to Transport implementations at construction time.
 * Each implementation may support additional options beyond these.
 */
export interface TransportOptions {
  /** URL or address to connect to (WebSocket URL, bridge identifier, etc.) */
  url?: string;

  /** Headers to send during connection upgrade (WebSocket only) */
  headers?: Record<string, string>;

  /** Connection timeout in milliseconds */
  timeoutMs?: number;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Check if a transport is currently open and ready to send messages.
 */
export function isTransportOpen(transport: Transport): boolean {
  return transport.readyState === TransportState.OPEN;
}

/**
 * Check if a transport is in a terminal state (closing or closed).
 */
export function isTransportClosed(transport: Transport): boolean {
  return transport.readyState === TransportState.CLOSING || transport.readyState === TransportState.CLOSED;
}
