/** HMAC signatures for Core's internal service calls (Store, Fleet integration). */
import {createHash, createHmac, timingSafeEqual} from "node:crypto"

export const SERVICE_HEADERS = {
  service: "x-mentra-service",
  timestamp: "x-mentra-service-timestamp",
  signature: "x-mentra-service-signature",
} as const

const DEFAULT_MAX_SKEW_MS = 60_000

interface SignedFields {
  method: string
  /** URL path plus query string exactly as sent. */
  pathWithQuery: string
  body: string
  timestampMs: number
}

/** HMAC-SHA256 over `<ts>\n<METHOD>\n<pathWithQuery>\n<sha256hex(body)>`, base64url. */
export function signServiceRequest(input: SignedFields & {secret: string}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("hex")
  const signed = `${input.timestampMs}\n${input.method.toUpperCase()}\n${input.pathWithQuery}\n${bodyHash}`
  return createHmac("sha256", input.secret).update(signed).digest("base64url")
}

/** True when `signature` matches any of `secrets` (rotation) and the timestamp is within the skew window. */
export function verifyServiceRequest(
  input: SignedFields & {
    secrets: readonly string[]
    signature: string
    nowMs: number
    maxSkewMs?: number
  },
): boolean {
  if (!Number.isFinite(input.timestampMs) || !Number.isFinite(input.nowMs)) return false
  if (Math.abs(input.nowMs - input.timestampMs) > (input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)) return false
  const provided = Buffer.from(input.signature)
  let matched = false
  for (const secret of input.secrets) {
    const expected = Buffer.from(signServiceRequest({...input, secret}))
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true
  }
  return matched
}
