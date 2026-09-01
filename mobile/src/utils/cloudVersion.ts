/**
 * @fileoverview Minimum-client-version gate against Cloud V2 Runtime
 * (GET /api/client/min-version, unauthenticated).
 */
import {AsyncResult, result as Res} from "typesafe-ts"

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

export function fetchMinimumClientVersion(
  runtimeUrl: string,
  attempts = 3,
  delayMs = 1000,
): AsyncResult<{required: string; recommended: string}, Error> {
  return Res.try_async(async () => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${normalizedBaseUrl(runtimeUrl)}/api/client/min-version`)
        if (!res.ok) throw new Error(`min-version HTTP ${res.status}`)
        const body = (await res.json()) as {data?: {required?: string; recommended?: string}}
        const data = body?.data ?? (body as {required?: string; recommended?: string})
        if (typeof data?.required !== "string") throw new Error("min-version: malformed response")
        return {required: data.required, recommended: data.recommended ?? data.required}
      } catch (err) {
        lastErr = err
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })
}
