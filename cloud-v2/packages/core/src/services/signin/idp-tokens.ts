/**
 * @fileoverview Identity-provider access tokens presented to Core.
 *
 * A website's server (the Developer Console) or the CLI calls Core with the
 * access token its identity provider issued, and Core's portals verify the
 * token from their own code exchange. Core maps the person to the same Core
 * user the phone has: `("mentra", Supabase user ID)` on hosted Core, or
 * `(provider tenantId, subject claim)` on a Private Cloud.
 *
 * Supabase OAuth access tokens are checked as the spec requires:
 *  - signature: HS256 with SUPABASE_JWT_SECRET, or RS256 / ES256 with the
 *    project's key set (an unknown `kid` refreshes it once);
 *  - `iss` equal to CLOUD_CORE_SUPABASE_ISSUER, `aud` "authenticated", 30 s of
 *    clock tolerance on `exp`, and `iat` no later than now + 30 s;
 *  - `client_id` on CLOUD_CORE_WEB_CLIENT_IDS (this environment's web clients
 *    only), a non-empty `sub`, and an `amr` entry with a numeric timestamp;
 *  - a session start (the earliest `amr[].timestamp`) not before the person's
 *    `webSignInsRevokedAt`. A refresh mints a new `iat` but keeps `amr`, so
 *    `iat` alone could not enforce a revocation.
 * Email verification comes only from the account's `email_confirmed_at`
 * (cached 5 minutes per person); a Supabase token's `email_verified` sits in
 * user-editable `user_metadata` and is never read.
 *
 * Private Cloud provider tokens get the checks the phone token exchange
 * applies (issuer, audience, algorithms, required scopes, allowed clients,
 * directory tenant, subject claim), are refused when they carry a `nonce` (an
 * ID token), and are refused when issued before `webSignInsRevokedAt`.
 *
 * Either kind is refused for a deleted account (`isDeletedAccount`).
 *
 * An invalid token is `null`. An outage (the key set or the account directory
 * cannot answer) throws `IdentityProviderUnavailableError`, which callers turn
 * into 503: never a successful, and never a silently degraded, sign-in.
 */

import {createLogger} from "@mentra/cloud-shared"
import * as jose from "jose"

import {AccountError} from "../account/account-error"
import {getAccountForSignIn, isGotrueAdminConfigured} from "../account/gotrue.client"
import {findOrCreateUser, isDeletedAccount} from "../user.service"
import {findProviderByIssuer, webClientIds, type WebIdentityProvider} from "./config"
import {canonicalEmail, trustedEmail} from "./email-trust"
import {KeySetUnavailableError, resetKeySets, verifyWithKeySet} from "./key-sets"

const logger = createLogger("core").child({service: "idp-tokens"})

const SUPABASE_CLOCK_TOLERANCE_SEC = 30
const PROVIDER_CLOCK_TOLERANCE_SEC = 5 * 60
const EMAIL_CACHE_TTL_MS = 5 * 60_000
const EMAIL_CACHE_MAX_ENTRIES = 10_000

export interface IdpIdentity {
  provider: WebIdentityProvider
  mentraUserId: string
  tenantId: string
  subject: string
  email: string | null
  emailVerified: boolean
  clientId: string | null
  issuedAt: Date
  /** Supabase: the earliest `amr[].timestamp`; null for other providers. */
  sessionStartedAt: Date | null
}

export class IdentityProviderUnavailableError extends Error {
  override name = "IdentityProviderUnavailableError"
}

interface CachedAccount {
  email: string | null
  emailConfirmed: boolean
  expiresAt: number
}

const accountCache = new Map<string, CachedAccount>()

/** Forget cached account emails and key sets (tests, and after a configuration change). */
export function resetIdpTokenCaches(): void {
  accountCache.clear()
  resetKeySets()
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function earliestAmrTimestamp(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null
  const timestamps = amr
    .map(entry => (entry && typeof entry === "object" ? (entry as {timestamp?: unknown}).timestamp : undefined))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  return timestamps.length > 0 ? Math.min(...timestamps) : null
}

/**
 * Verify an identity-provider access token and resolve its Core user. Returns
 * null for any token Core does not accept; throws
 * IdentityProviderUnavailableError when the provider cannot be asked.
 */
export async function verifyIdpAccessToken(token: string, opts: {now?: Date} = {}): Promise<IdpIdentity | null> {
  let issuer: string | null
  try {
    issuer = stringClaim(jose.decodeJwt(token).iss)
  } catch {
    return null
  }
  if (!issuer) return null
  const provider = findProviderByIssuer(issuer)
  if (!provider) return null
  const now = opts.now ?? new Date()
  return provider.kind === "supabase" ? verifySupabaseToken(token, provider, now) : verifyProviderToken(token, provider, now)
}

async function verifySupabaseToken(token: string, provider: WebIdentityProvider, now: Date): Promise<IdpIdentity | null> {
  let alg: string
  try {
    alg = jose.decodeProtectedHeader(token).alg ?? ""
  } catch {
    return null
  }
  const options: jose.JWTVerifyOptions = {
    issuer: provider.issuer,
    audience: "authenticated",
    clockTolerance: SUPABASE_CLOCK_TOLERANCE_SEC,
    currentDate: now,
  }
  let payload: jose.JWTPayload
  try {
    if (alg === "HS256") {
      const secret = process.env.SUPABASE_JWT_SECRET?.trim()
      if (!secret) {
        logger.warn("SUPABASE_JWT_SECRET is not set; refusing HS256 Supabase tokens")
        return null
      }
      ;({payload} = await jose.jwtVerify(token, new TextEncoder().encode(secret), {...options, algorithms: ["HS256"]}))
    } else if (provider.algorithms.includes(alg)) {
      ;({payload} = await verifyWithKeySet(token, provider.jwksUrl, {...options, algorithms: provider.algorithms}))
    } else {
      return null
    }
  } catch (err) {
    if (err instanceof KeySetUnavailableError) throw new IdentityProviderUnavailableError(err.message)
    return null
  }

  const clientId = stringClaim(payload.client_id)
  if (!clientId || !webClientIds().has(clientId)) return null
  const subject = stringClaim(payload.sub)
  if (!subject) return null
  if (typeof payload.iat !== "number" || payload.iat > now.getTime() / 1000 + SUPABASE_CLOCK_TOLERANCE_SEC) return null
  const sessionStart = earliestAmrTimestamp(payload.amr)
  if (sessionStart === null) return null
  const sessionStartedAt = new Date(sessionStart * 1000)

  const user = await findOrCreateUser({tenantId: provider.tenantId, tenantUserId: subject})
  if (isDeletedAccount(user)) return null
  const revokedAt = (user as {webSignInsRevokedAt?: Date | null}).webSignInsRevokedAt
  if (revokedAt && sessionStartedAt.getTime() < revokedAt.getTime()) return null

  const account = await supabaseAccount(subject, payload.email)
  const email = trustedEmail({provider, email: account.email, supabaseEmailConfirmed: account.emailConfirmed})
  return {
    provider,
    mentraUserId: user.mentraUserId,
    tenantId: provider.tenantId,
    subject,
    email: email.email,
    emailVerified: email.verified,
    clientId,
    issuedAt: new Date(payload.iat * 1000),
    sessionStartedAt,
  }
}

/**
 * The account's email and its confirmation, from GoTrue's admin API, cached
 * for 5 minutes per person. Without an admin directory configured, the token's
 * email is shown and never verified.
 */
async function supabaseAccount(subject: string, tokenEmail: unknown): Promise<{email: string | null; emailConfirmed: boolean}> {
  if (!isGotrueAdminConfigured()) return {email: canonicalEmail(tokenEmail), emailConfirmed: false}
  const cached = accountCache.get(subject)
  if (cached && cached.expiresAt > Date.now()) return cached
  let account
  try {
    account = await getAccountForSignIn(subject)
  } catch (err) {
    if (err instanceof AccountError) throw new IdentityProviderUnavailableError("account directory unavailable")
    throw err
  }
  const entry: CachedAccount = {
    email: account?.email ?? null,
    emailConfirmed: account?.emailConfirmed ?? false,
    expiresAt: Date.now() + EMAIL_CACHE_TTL_MS,
  }
  if (accountCache.size >= EMAIL_CACHE_MAX_ENTRIES) accountCache.clear()
  accountCache.set(subject, entry)
  return entry
}

async function verifyProviderToken(token: string, provider: WebIdentityProvider, now: Date): Promise<IdpIdentity | null> {
  const checks = provider.accessToken
  if (!checks) return null
  let payload: jose.JWTPayload
  try {
    ;({payload} = await verifyWithKeySet(token, provider.jwksUrl, {
      issuer: provider.issuer,
      audience: checks.audience,
      algorithms: provider.algorithms,
      clockTolerance: PROVIDER_CLOCK_TOLERANCE_SEC,
      currentDate: now,
    }))
  } catch (err) {
    if (err instanceof KeySetUnavailableError) throw new IdentityProviderUnavailableError(err.message)
    return null
  }

  // An ID token is never a bearer credential. Core's own sign-in always sends a nonce.
  if (payload.nonce !== undefined) return null
  const granted = new Set(typeof payload.scp === "string" ? payload.scp.split(" ").filter(Boolean) : [])
  if (checks.requiredScopes.some(scope => !granted.has(scope))) return null
  const clientId = stringClaim(payload.azp) ?? stringClaim(payload.appid)
  if (checks.allowedClientIds !== null && (!clientId || !checks.allowedClientIds.includes(clientId))) return null
  const subject = stringClaim(payload[provider.subjectClaim])
  if (!subject) return null
  if (provider.expectedDirectoryTenantId) {
    const directoryTenant = provider.directoryTenantClaim ? stringClaim(payload[provider.directoryTenantClaim]) : null
    if (directoryTenant !== provider.expectedDirectoryTenantId) return null
  }
  if (typeof payload.iat !== "number") return null

  const issuedAt = new Date(payload.iat * 1000)
  const user = await findOrCreateUser({tenantId: provider.tenantId, tenantUserId: subject})
  if (isDeletedAccount(user)) return null
  const revokedAt = (user as {webSignInsRevokedAt?: Date | null}).webSignInsRevokedAt
  if (revokedAt && issuedAt.getTime() < revokedAt.getTime()) return null

  const email = trustedEmail({
    provider,
    email: payload[provider.browser?.emailClaim ?? "email"],
    tokenEmailVerified: payload.email_verified,
  })
  return {
    provider,
    mentraUserId: user.mentraUserId,
    tenantId: provider.tenantId,
    subject,
    email: email.email,
    emailVerified: email.verified,
    clientId,
    issuedAt,
    sessionStartedAt: null,
  }
}
