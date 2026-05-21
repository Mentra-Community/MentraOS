/**
 * @fileoverview Bridge envelope format.
 *
 * Every message between @mentra/miniapp and LocalMiniappRuntime is wrapped in
 * this envelope for request/response correlation.
 *
 *   { payload: {...}, requestId?: string }
 */

export interface MiniappEnvelope<P = unknown> {
  payload: P
  /** Correlates request/response pairs. Set by the sender when it wants a reply. */
  requestId?: string
}

/** Serialize an envelope for postMessage / WebSocket transport. */
export function serializeEnvelope(envelope: MiniappEnvelope): string {
  return JSON.stringify(envelope)
}

/**
 * Parse a serialized envelope. Returns null for any malformed input — never throws.
 * Transports should pass raw strings in and silently drop nulls.
 */
export function parseEnvelope(raw: unknown): MiniappEnvelope | null {
  if (typeof raw !== "string") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  if (typeof obj.payload !== "object" || obj.payload === null) return null
  if (obj.requestId !== undefined && typeof obj.requestId !== "string") return null

  return {
    payload: obj.payload as unknown,
    requestId: obj.requestId as string | undefined,
  }
}

/** Generate a short random requestId. Browser-native (crypto.randomUUID). */
export function makeRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // Fallback for older engines: timestamp + random suffix. Not cryptographically secure.
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
