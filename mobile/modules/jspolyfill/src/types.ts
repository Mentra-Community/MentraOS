/**
 * Shared envelope types for the MentraJS runtime — the polyfill bundle
 * uses these to drive globalThis.__deliver and the dispatch surface.
 *
 * Native (Swift on iOS, Kotlin on Android) injects:
 *   - __dispatch(iface: string, method: string, argsJson: string) → string
 *   - __hostLog(level: string, messageJson: string) → void
 *   - __hostError(payloadJson: string) → void
 *   - __hostUnhandledRejection(payloadJson: string) → void
 *
 * The polyfill (`startup.js`) installs:
 *   - globalThis.__deliver(envelopeJson: string) → void — host pushes here
 *   - globalThis.console, setTimeout, setInterval, fetch, WebSocket, etc.
 *   - rewires window.onerror / unhandledrejection to __hostError /
 *     __hostUnhandledRejection.
 *   - Calls __dispatch('__runtime', 'ready', []) once init is done so the
 *     host's signalReady NACK timer can be cleared.
 *
 * The shapes are JSON-serialisable strings on the wire — both sides pass
 * JSON, never JS values directly. This keeps the bridge minimal and
 * platform-symmetric.
 */

export interface DispatchRequest {
  iface: string
  method: string
  args: unknown[]
  reqId?: string
}

export interface DispatchError {
  code: string
  message?: string
  details?: Record<string, unknown>
}

export type DispatchResponse =
  | {reqId: string; ok: true; result: unknown}
  | {reqId: string; ok: false; error: DispatchError}

export type DeliverEnvelope =
  | {kind: "init"; sessionId: string}
  | {kind: "event"; iface: string; payload: unknown}
  | {kind: "response"; reqId: string; ok: true; result?: unknown}
  | {kind: "response"; reqId: string; ok: false; error: DispatchError}

/**
 * Error codes returned via DispatchError.code. The native dispatcher and
 * the SDK shim must agree on this vocabulary — adding a code without
 * updating both sides is a wire-format break.
 */
export const DISPATCH_ERROR_CODES = {
  PERMISSION_NOT_DECLARED: "PERMISSION_NOT_DECLARED",
  INTERFACE_NOT_FOUND: "INTERFACE_NOT_FOUND",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INVALID_ARGS: "INVALID_ARGS",
  NATIVE_THROW: "NATIVE_THROW",
  TIMEOUT: "TIMEOUT",
} as const

export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[keyof typeof DISPATCH_ERROR_CODES]
