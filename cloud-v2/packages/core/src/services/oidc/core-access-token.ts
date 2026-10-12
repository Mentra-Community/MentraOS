/**
 * @fileoverview Core access tokens: the access tokens Core's sign-in server
 * issues to its clients, presented back to Core's API and to the Store's
 * service API.
 *
 * `verifyCoreAccessToken` accepts a token only when all of these hold:
 * - the header is `alg` EdDSA, `typ` `at+jwt` and `kid` `mentra-oidc-1`, and
 *   the signature verifies with Core's own key (read locally, no key set
 *   fetch);
 * - `iss` is this Core's `CLOUD_CORE_OIDC_ISSUER` (so another environment's
 *   tokens are refused) and `aud` is Core's API (`urn:mentra:core`);
 * - `exp` and `iat` are within 30 seconds of tolerance;
 * - `client_id` names an active first-party client;
 * - the person exists, is not deleted, signed in through a source that is
 *   still configured, and the token was issued no earlier than their
 *   `webSignInsRevokedAt`.
 *
 * Phone access tokens, runtime tokens, miniapp tokens, account subject tokens
 * and the provider's ID tokens all fail the header or claim pins, even where
 * they share Core's signing key.
 */

import * as jose from "jose"

import {findClient} from "./clients"
import {CORE_API_RESOURCE, oidcIssuer} from "./config"
import {OIDC_TOKEN_ALG, OIDC_TOKEN_KID, oidcVerificationKey} from "./keys"
import {loadAccount} from "./account"

export const ACCESS_TOKEN_TYP = "at+jwt"
const CLOCK_TOLERANCE_SEC = 30

export interface CoreAccessIdentity {
  mentraUserId: string
  tenantId: string
  sourceId: string
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  clientId: string
  scopes: Set<string>
  issuedAt: Date
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** The person behind a Core access token, or null for any token Core does not accept. */
export async function verifyCoreAccessToken(token: string, opts: {now?: Date} = {}): Promise<CoreAccessIdentity | null> {
  const issuer = oidcIssuer()
  if (!issuer || typeof token !== "string" || !token) return null
  let header: jose.ProtectedHeaderParameters
  try {
    header = jose.decodeProtectedHeader(token)
  } catch {
    return null
  }
  if (header.alg !== OIDC_TOKEN_ALG || header.kid !== OIDC_TOKEN_KID || header.typ?.toLowerCase() !== ACCESS_TOKEN_TYP) return null

  const now = opts.now ?? new Date()
  let payload: jose.JWTPayload
  try {
    ;({payload} = await jose.jwtVerify(token, await oidcVerificationKey(), {
      issuer,
      audience: CORE_API_RESOURCE,
      algorithms: [OIDC_TOKEN_ALG],
      typ: ACCESS_TOKEN_TYP,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      currentDate: now,
      requiredClaims: ["sub", "iat", "exp", "client_id"],
    }))
  } catch {
    return null
  }

  const clientId = stringClaim(payload.client_id)
  const subject = stringClaim(payload.sub)
  if (!clientId || !subject || typeof payload.iat !== "number") return null
  if (payload.iat > now.getTime() / 1000 + CLOCK_TOLERANCE_SEC) return null
  const client = await findClient(clientId)
  if (!client?.firstParty) return null

  // A deleted account, a token issued before the person's revocation, or a source no longer configured: refused.
  const identity = await loadAccount(subject, payload.iat)
  if (!identity) return null

  return {
    mentraUserId: subject,
    tenantId: identity.tenantId,
    sourceId: identity.sourceId,
    subject: identity.subject,
    email: identity.email ?? null,
    emailVerified: identity.emailVerified,
    name: identity.name ?? null,
    clientId,
    scopes: new Set(typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : []),
    issuedAt: new Date(payload.iat * 1000),
  }
}
