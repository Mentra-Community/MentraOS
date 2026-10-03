/**
 * Host-side `PREVIEW_TRACE` lines for the stream preview.
 *
 * Same shape as the native and page layers: a literal grep marker, `phase=`, then `key=value`
 * pairs carrying whichever correlation ids exist at that point (`previewTraceId runtimeId
 * handleId meetingId docGen mountEpoch`) and a monotonic `t`. Lifecycle lines are low volume and
 * stay on in release builds, so the console capture puts them in bug reports. Nothing is logged
 * per frame.
 */

/** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
export const PREVIEW_TRACE_MARKER = "PREVIEW_TRACE"

const REDACTED = "<redacted>"
/** Matched case-insensitively as substrings. */
const SENSITIVE_KEYS = ["token", "secret", "password", "authorization", "meetingurl", "url"]
/** Repeated identical warnings: the first, then a count at most this often. */
export const PREVIEW_TRACE_RATE_LIMIT_MS = 10_000

export type PreviewTraceFields = Record<string, string | number | boolean | null | undefined>

export interface PreviewTraceLogger {
  info(phase: string, fields?: PreviewTraceFields): void
  warn(phase: string, fields?: PreviewTraceFields): void
  /** Rate-limited per `key`: logs the first, then `repeated=N` at most every 10 s. */
  warnLimited(key: string, phase: string, fields?: PreviewTraceFields): void
  /** An already formatted line from another layer (native), redacted on the way through. */
  forward(level: "info" | "warn", line: string): void
}

export type PreviewTraceSink = (level: "log" | "warn", line: string) => void

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive))
}

function render(value: string | number | boolean | null): string {
  const text = String(value)
  // Anything URL-shaped loses its query and fragment; a tokenised URL must never reach a log.
  const scheme = text.indexOf("://")
  const stripped = scheme >= 0 ? text.replace(/[?#].*$/, `?${REDACTED}`) : text
  return stripped.replace(/\s+/g, "_")
}

export function formatPreviewTrace(phase: string, fields: PreviewTraceFields, t: number): string {
  const parts = [`[${PREVIEW_TRACE_MARKER}]`, "layer=host", `phase=${phase}`]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${isSensitive(key) ? REDACTED : render(value)}`)
  }
  parts.push(`t=${Math.round(t)}`)
  return parts.join(" ")
}

/**
 * Redact a preformatted `key=value` line: sensitive keys lose their value, URLs lose their query
 * and fragment. Native already redacts; this is the host's own guarantee for bug reports.
 */
export function redactPreviewTraceLine(line: string): string {
  return line
    .replace(
      /\b([\w.-]*(?:token|secret|password|authorization|meetingurl|url)[\w.-]*)(=|":\s*"?)([^\s",}]+)/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/(\w+:\/\/[^\s?#"]*)[?#][^\s"]*/g, `$1?${REDACTED}`)
}

const consoleSink: PreviewTraceSink = (level, line) => {
  if (level === "warn") console.warn(line)
  else console.log(line)
}

export function createPreviewTraceLogger(
  options: {now?: () => number; sink?: PreviewTraceSink} = {},
): PreviewTraceLogger {
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()))
  const sink = options.sink ?? consoleSink
  const limited = new Map<string, {since: number; suppressed: number}>()
  const emit = (level: "log" | "warn", phase: string, fields: PreviewTraceFields = {}) =>
    sink(level, formatPreviewTrace(phase, fields, now()))
  return {
    info: (phase, fields) => emit("log", phase, fields),
    forward: (level, line) => sink(level === "warn" ? "warn" : "log", redactPreviewTraceLine(String(line))),
    warn: (phase, fields) => emit("warn", phase, fields),
    warnLimited(key, phase, fields) {
      const at = now()
      const entry = limited.get(key)
      if (!entry) {
        limited.set(key, {since: at, suppressed: 0})
        emit("warn", phase, fields)
        return
      }
      entry.suppressed += 1
      if (at - entry.since >= PREVIEW_TRACE_RATE_LIMIT_MS) {
        emit("warn", phase, {...fields, repeated: entry.suppressed})
        entry.since = at
        entry.suppressed = 0
      }
    },
  }
}
