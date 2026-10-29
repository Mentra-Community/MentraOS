import {randomUrlSafe} from "@/utils/auth/pkce"

export const ACCOUNT_LOGIN_FAILURE_MARKER = "AUTH: account login failure "

export type AccountLoginPhase = "request" | "fetch" | "http" | "response-json" | "session"
type Observation = {requestId: string | null; startedAtMs: number | null}

function timestamp(): number | null {
  try {
    const value = Date.now()
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

/** Diagnostic preparation must never prevent the original password request. */
export function beginAccountLoginObservation(): Observation {
  let requestId: string | null = null
  try {
    const value = randomUrlSafe(16)
    if (/^[A-Za-z0-9_-]{22}$/.test(value)) requestId = value
  } catch {
    // Missing randomness means correlation is unavailable, not a login failure.
  }
  return {requestId, startedAtMs: timestamp()}
}

function errorString(error: unknown, key: "name" | "message"): string {
  try {
    if (typeof error !== "object" || error === null) return ""
    const value: unknown = (error as Record<string, unknown>)[key]
    return typeof value === "string" ? value.slice(0, 512) : ""
  } catch {
    return ""
  }
}

function category(error: unknown, phase: AccountLoginPhase) {
  if (phase === "http") return "http"
  if (phase === "response-json") return "response-json"
  if (phase !== "fetch") return "other"
  const message = errorString(error, "message")
  // Inspect only to select a fixed value. Never persist the native message,
  // URL, body, cause, stack or arbitrary provider code. A generic fetch failure
  // does not prove DNS, connection or TLS failure.
  if (/ENOTFOUND|EAI_AGAIN|UnknownHostException|unable to resolve host/i.test(message)) return "dns"
  if (/ECONNREFUSED|ECONNRESET|failed to connect|connection refused/i.test(message)) return "connect"
  if (/SSLHandshakeException|certificate verify failed|TLS handshake/i.test(message)) return "tls"
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) return "timeout"
  if (errorString(error, "name") === "AbortError") return "aborted"
  if (/network request failed|failed to fetch|networkerror/i.test(message)) return "network"
  return "other"
}

/** One allowlisted string survives both native console output and LogRingBuffer. */
export function recordAccountLoginFailure(
  observation: Observation,
  phase: AccountLoginPhase,
  status: number | null,
  error: unknown,
): void {
  try {
    const observedAtMs = timestamp()
    const elapsedMs =
      observedAtMs !== null && observation.startedAtMs !== null && observedAtMs >= observation.startedAtMs
        ? observedAtMs - observation.startedAtMs
        : null
    const name = errorString(error, "name")
    const errorName = ["Error", "TypeError", "SyntaxError", "AbortError"].includes(name) ? name : "unknown"
    console.warn(
      ACCOUNT_LOGIN_FAILURE_MARKER +
        JSON.stringify({
          schemaVersion: 1,
          method: "POST",
          route: "/api/account/login",
          requestId: observation.requestId,
          startedAtMs: observation.startedAtMs,
          observedAtMs,
          elapsedMs,
          phase,
          status: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          category: category(error, phase),
          errorName,
        }),
    )
  } catch {
    // A failed diagnostic sink must preserve the original error and result.
  }
}
