/**
 * @fileoverview Transport abstraction for @mentra/miniapp.
 *
 * Two v1 implementations:
 *   - PostMessageTransport — inside MentraOS WebView, uses window.ReactNativeWebView
 *   - LocalSocketTransport — in external Safari/Chrome fallback, uses ws://127.0.0.1
 *
 * createTransport() in auto.ts picks the right one based on environment.
 */

export type TransportMessageHandler = (raw: string) => void
export type TransportDisconnectHandler = (reason: string) => void

export interface Transport {
  /** Establish whatever connection the transport needs. May be a no-op. */
  open(): Promise<void>
  /** Send a serialized envelope. */
  send(raw: string): void
  /** Register a callback for incoming serialized envelopes. */
  onMessage(handler: TransportMessageHandler): void
  /** Register a callback for transport-level disconnects / errors. */
  onDisconnect(handler: TransportDisconnectHandler): void
  /** Close the transport cleanly. Idempotent. */
  close(): void
  isOpen(): boolean
}
