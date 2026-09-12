/**
 * @fileoverview Correlated stage logging for the SoftAP calling pipeline (host side).
 *
 * TEMPORARY DIAGNOSTIC. Every line carries the literal `SOFTAP_TRACE` marker so a single
 * `rg -n 'SOFTAP_TRACE'` finds all of them at cleanup time. Set `SOFTAP_TRACE_ENABLED` to
 * false to mute the layer for a release without deleting call sites.
 *
 * The `phase=` shape matches the `[AcsMeeting] phase=...` convention already used by
 * AcsMeetingService, so existing log tooling keeps parsing it.
 *
 * `traceId` is minted here when the hotspot request starts and travels to the glasses in
 * `start_stream`. Both devices stamp the same id on every line, which is the only way to
 * correlate two logs whose clocks were never synchronised.
 */

/** Master switch. Flip to false to mute the trace without removing call sites. */
export const SOFTAP_TRACE_ENABLED = true

/** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
export const SOFTAP_TRACE_MARKER = "SOFTAP_TRACE"

const REDACTED = "<redacted>"

/** Keys whose values must never reach the log. Matched case-insensitively as substrings. */
const SENSITIVE_KEYS = [
  "password",
  "passwd",
  "passphrase",
  "psk",
  "token",
  "secret",
  "credential",
  "authorization",
  "bearer",
  "meetingurl",
]

let traceId = ""
let originMs = 0
let lastStage = ""

/** Mint a trace id and reset the elapsed-time origin. Called when the hotspot request starts. */
export function beginSoftapTrace(id: string = newSoftapTraceId()): string {
  traceId = id
  originMs = Date.now()
  lastStage = ""
  return id
}

export function resetSoftapTrace(): void {
  traceId = ""
  originMs = 0
  lastStage = ""
}

export function softapTraceId(): string {
  return traceId
}

/** Last stage logged; use as failure context when reporting an error. */
export function softapLastStage(): string {
  return lastStage
}

export function newSoftapTraceId(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(16)
}

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive))
}

/** Drop `?query`, `#fragment`, and `user:pass@` from anything URL-shaped. */
function stripUrlSecrets(text: string): string {
  const schemeIndex = text.indexOf("://")
  if (schemeIndex < 0) return text

  let result = text
  const query = result.indexOf("?")
  if (query >= 0) result = `${result.slice(0, query)}?${REDACTED}`
  const fragment = result.indexOf("#")
  if (fragment >= 0) result = result.slice(0, fragment)

  const at = result.indexOf("@", schemeIndex + 3)
  if (at >= 0) {
    result = `${result.slice(0, schemeIndex + 3)}${REDACTED}@${result.slice(at + 1)}`
  }
  return result
}

/**
 * Redact secrets outright and strip query strings from URLs. The local WHIP URL is genuinely
 * useful in a trace, but a URL carrying a watch token is not, so query and userinfo go.
 */
export function sanitizeSoftapField(key: string, value: unknown): unknown {
  if (isSensitive(key)) return REDACTED
  if (typeof value === "string") return stripUrlSecrets(value)
  return value
}

/** Apply {@link sanitizeSoftapField} across an object, leaving non-string values alone. */
export function sanitizeSoftapData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = sanitizeSoftapField(key, value)
  }
  return result
}

/** Build the log head. Exported for tests. */
export function formatSoftapTrace(id: string, stage: string, elapsedMs: number): string {
  const head = id ? `[${SOFTAP_TRACE_MARKER}] traceId=${id} phase=${stage}` : `[${SOFTAP_TRACE_MARKER}] phase=${stage}`
  return `${head} elapsedMs=${elapsedMs}`
}

/** Log one pipeline stage transition. */
export function softapTrace(stage: string, data?: Record<string, unknown>): void {
  if (!SOFTAP_TRACE_ENABLED) return
  lastStage = stage
  const elapsedMs = originMs === 0 ? 0 : Date.now() - originMs
  const head = formatSoftapTrace(traceId, stage, elapsedMs)
  if (data) console.log(head, sanitizeSoftapData(data))
  else console.log(head)
}

/** Warn-level variant so genuine failures survive a log level filter. */
export function softapTraceFailure(stage: string, data?: Record<string, unknown>): void {
  if (!SOFTAP_TRACE_ENABLED) return
  const elapsedMs = originMs === 0 ? 0 : Date.now() - originMs
  const head = formatSoftapTrace(traceId, stage, elapsedMs)
  console.warn(head, sanitizeSoftapData({...(data ?? {}), afterStage: lastStage}))
}
