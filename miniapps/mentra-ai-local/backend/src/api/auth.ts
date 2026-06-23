/**
 * Shared Mentra auth middleware for the API routes.
 *
 * Centralizes packageName + an onUnauthorized hook that logs WHY a token was
 * rejected (issuer/audience/signature/expiry) to the backend console — the
 * phone host redacts token-shaped error bodies, so this server-side log is the
 * reliable place to see auth failures during dev.
 */

import {createMentraAuth, type MentraAuthError, type HonoLikeContext} from "@mentra/auth"

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.mentra.ai.local"

const mentraAuth = createMentraAuth({packageName: PACKAGE_NAME})

/** Decode JWT claims without verifying (diagnostic only — to log aud/iss/sub). */
function decodeJwtClaims(authHeader?: string): Record<string, unknown> | null {
  try {
    const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim()
    const payload = token.split(".")[1]
    if (!payload) return null
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function mentraAuthMiddleware() {
  return mentraAuth.hono({
    onUnauthorized: (error: MentraAuthError, c: HonoLikeContext) => {
      // Decode (WITHOUT verifying) the incoming token so we can log its actual
      // aud/iss/sub — the verify error only says "unexpected aud" without the value.
      const claims = decodeJwtClaims(c.req.header("Authorization"))
      console.warn(
        `[auth] 401 rejected: ${error.message}\n` +
          `       expectedAud=${PACKAGE_NAME}\n` +
          `       tokenAud=${JSON.stringify(claims?.aud)} tokenIss=${JSON.stringify(claims?.iss)} tokenSub=${JSON.stringify(claims?.sub)}\n` +
          `       jwks=${process.env.MENTRA_AUTH_JWKS_URL ?? "(default prod)"} issuers=${process.env.MENTRA_AUTH_ISSUERS ?? "(default cloud-core)"}`,
      )
      return c.json({error: error.message}, 401)
    },
  })
}
