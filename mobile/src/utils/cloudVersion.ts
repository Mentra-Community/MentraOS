/**
 * @fileoverview Minimum-client-version gate against Cloud V2 Runtime
 * (GET /api/client/min-version, unauthenticated).
 */
import semver from "semver"
import {AsyncResult, result as Res} from "typesafe-ts"

/**
 * Build the policy endpoint from a Runtime base URL. A base URL that carries a
 * query or fragment cannot host REST paths, so it is rejected instead of
 * producing a request the server would misroute.
 */
export function minimumClientVersionUrl(runtimeUrl: string): string {
  let url: URL
  try {
    url = new URL(runtimeUrl)
  } catch {
    throw new Error("min-version: Runtime URL is invalid")
  }
  if (url.search || url.hash) throw new Error("min-version: Runtime URL cannot contain a query or fragment")
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/client/min-version`
  return url.toString()
}

function policyVersion(value: unknown, field: string): string {
  if (typeof value !== "string" || semver.valid(value) !== value) {
    throw new Error(`min-version: malformed ${field} version`)
  }
  return value
}

export function fetchMinimumClientVersion(
  runtimeUrl: string,
  attempts = 3,
  delayMs = 1000,
): AsyncResult<{required: string; recommended: string}, Error> {
  return Res.try_async(async () => {
    const endpoint = minimumClientVersionUrl(runtimeUrl)
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(endpoint)
        if (!res.ok) throw new Error(`min-version HTTP ${res.status}`)
        const body = (await res.json()) as {data?: {required?: unknown; recommended?: unknown}}
        const data = body?.data ?? (body as {required?: unknown; recommended?: unknown})
        const required = policyVersion(data?.required, "required")
        const recommended = data?.recommended == null ? required : policyVersion(data.recommended, "recommended")
        return {required, recommended}
      } catch (err) {
        lastErr = err
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })
}
