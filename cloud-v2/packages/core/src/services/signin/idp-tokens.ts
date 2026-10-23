/**
 * @fileoverview Identity-provider tokens where they enter Core: the Supabase
 * access token the sign-in page hands to Core's sign-in server.
 *
 * Websites, the CLI and Core's own APIs never accept identity-provider tokens
 * as bearers: they use Core's own access tokens (`services/oidc`). The phone
 * token exchange verifies its subject tokens itself (`session.service`).
 *
 * An invalid token is `null`. An outage (the key set or the account directory
 * cannot answer) throws `IdentityProviderUnavailableError`, which callers turn
 * into 503: never a successful, and never a silently degraded, sign-in.
 */

import {createLogger} from "@mentra/cloud-shared"
import * as jose from "jose"

import {AccountError} from "../account/account-error"
import {findAccountById, isGotrueAdminConfigured} from "../account/gotrue.client"
import {findOrCreateUser, isDeletedAccount} from "../user.service"
import {supabaseProvider, type WebIdentityProvider} from "./config"
import {canonicalEmail, trustedEmail} from "./email-trust"
import {KeySetUnavailableError, resetKeySets, verifyWithKeySet} from "./key-sets"

const logger = createLogger("core").child({service: "idp-tokens"})

const SUPABASE_CLOCK_TOLERANCE_SEC = 30

export class IdentityProviderUnavailableError extends Error {
  override name = "IdentityProviderUnavailableError"
}

/** Forget cached key sets (tests, and after a configuration change). */
export function resetIdpTokenCaches(): void {
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

// --- the sign-in page's hand-off -----------------------------------------------

/** Who a Supabase access token handed to Core's sign-in server stands for. */
export interface SupabaseHandoff {
  provider: WebIdentityProvider
  mentraUserId: string
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  /** The Supabase session's start: the earliest `amr[].timestamp`. */
  sessionStartedAt: Date
}

/**
 * Verify the Supabase access token the sign-in page hands to Core's sign-in
 * server, as the phone token exchange verifies Supabase tokens, plus the
 * session-start rule:
 *  - signature: HS256 with SUPABASE_JWT_SECRET, or RS256 / ES256 with the
 *    project's key set (an unknown `kid` refreshes it once);
 *  - `iss` equal to CLOUD_CORE_SUPABASE_ISSUER, `aud` "authenticated", 30 s of
 *    tolerance on `exp`, and `iat` no later than now + 30 s;
 *  - a first-party Supabase session's token: one issued to an OAuth client
 *    (it carries `client_id`) is refused;
 *  - a non-empty `sub`, and an `amr` entry with a numeric timestamp whose
 *    earliest value (the session's start) is not before the person's
 *    `webSignInsRevokedAt`; a refresh keeps it, so a session from before a
 *    revocation stays refused however often it was refreshed.
 * Email verification comes from the account's `email_confirmed_at`, read
 * fresh; the token's `user_metadata` is never read.
 *
 * Returns null for a token Core does not accept; throws
 * IdentityProviderUnavailableError when Supabase cannot be asked.
 */
export async function verifySupabaseHandoffToken(token: string, opts: {now?: Date} = {}): Promise<SupabaseHandoff | null> {
  const provider = supabaseProvider()
  if (!provider || typeof token !== "string" || !token) return null
  const now = opts.now ?? new Date()
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
      if (!secret) return null
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

  if (payload.client_id !== undefined) return null
  const subject = stringClaim(payload.sub)
  if (!subject) return null
  if (typeof payload.iat !== "number" || payload.iat > now.getTime() / 1000 + SUPABASE_CLOCK_TOLERANCE_SEC) return null
  const sessionStart = earliestAmrTimestamp(payload.amr)
  if (sessionStart === null) return null

  const user = await findOrCreateUser({tenantId: provider.tenantId, tenantUserId: subject})
  if (isDeletedAccount(user)) return null
  const revokedAt = (user as {webSignInsRevokedAt?: Date | null}).webSignInsRevokedAt
  if (revokedAt && sessionStart * 1000 < revokedAt.getTime()) return null

  let email: string | null
  let emailConfirmed = false
  let name: string | null = null
  if (isGotrueAdminConfigured()) {
    let account
    try {
      account = await findAccountById(subject)
    } catch (err) {
      if (err instanceof AccountError) throw new IdentityProviderUnavailableError("account directory unavailable")
      throw err
    }
    if (!account) return null
    email = account.email ?? null
    emailConfirmed = account.emailConfirmed
    name = account.name ?? null
  } else {
    email = canonicalEmail(payload.email)
  }
  const trusted = trustedEmail({provider, email, supabaseEmailConfirmed: emailConfirmed})
  return {
    provider,
    mentraUserId: user.mentraUserId,
    subject,
    email: trusted.email,
    emailVerified: trusted.verified,
    name,
    sessionStartedAt: new Date(sessionStart * 1000),
  }
}

/**
 * End the Supabase session a token belongs to (`POST {issuer}/logout?scope=local`
 * with that token, and the publishable key for Supabase's gateway). Best
 * effort: a failure is logged and never blocks sign-in.
 */
export async function endSupabaseSession(issuer: string, accessToken: string): Promise<void> {
  try {
    const headers: Record<string, string> = {authorization: `Bearer ${accessToken}`}
    const publishable = process.env.SUPABASE_ANON_KEY?.trim()
    if (publishable) headers.apikey = publishable
    const response = await fetch(`${issuer}/logout?scope=local`, {method: "POST", headers, signal: AbortSignal.timeout(5_000)})
    if (response.status !== 204) logger.warn({status: response.status}, "could not end the handed-off Supabase session")
  } catch (err) {
    logger.warn({errorName: (err as Error)?.name}, "could not end the handed-off Supabase session")
  }
}
