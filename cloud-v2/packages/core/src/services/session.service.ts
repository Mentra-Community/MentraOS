/**
 * @fileoverview Session aggregate. Token-exchange orchestration, refresh,
 * revocation, and Mentra access-token verification.
 *
 * What this service owns:
 *   - Orchestrating RFC 8693 token exchange (verify OEM JWT → find/create
 *     user → mint Mentra tokens).
 *   - Refresh-token rotation.
 *   - Session revocation (single and bulk-by-OEM).
 *   - Verifying Mentra-issued access tokens, including the revocation
 *     blacklist check.
 *
 * Mentra's own Ed25519 signing keypair is loaded lazily from env on first
 * use. Refresh tokens are HMAC-SHA256 hashed with a server-side pepper
 * (`REFRESH_TOKEN_PEPPER`) before storage; the plaintext exists only on
 * the SDK that received it.
 *
 * Spec: docs/issues/001-oem-auth/design.md
 *       ("Lifecycles" / "Token formats" / "Endpoints")
 */

import crypto from "node:crypto"
import * as jose from "jose"
import {ulid} from "ulid"
import {
  createLogger,
  signRuntimeToken,
  verifyAccessTokenSignature,
  AccessTokenError,
  type VerifiedAccessToken,
  type FederatedIdentity,
} from "@mentra/cloud-shared"
import {RefreshTokenModel} from "../models/refresh-token.model"
import {UserModel} from "../models/user.model"
import {RevokedJtiModel} from "../models/revoked-jti.model"
import {OemModel} from "../models/oem.model"
import {EnterpriseOrgModel} from "../models/enterprise-org.model"
import {
  InvalidGrant,
  InvalidRequest,
  OauthServerError,
  UnauthorizedClient,
  type TokenResponse,
} from "../types/oauth.types"
import {findOrCreateUser, isDeletedAccount, isDeletedAccountId} from "./user.service"
import {isConfiguredOidcTenant, recordSeenJti, verifyTenantJwt} from "./oem.service"
import {SUPABASE_ASYMMETRIC_ALGORITHMS, supabaseIssuer, supabaseJwksUrl} from "./signin/config"
import {KeySetUnavailableError, verifyWithKeySet} from "./signin/key-sets"
import {revokePortalSessionsForUser} from "./signin/browser-session.service"
import {endIdentityProviderSessions} from "./signin/idp-revocation"
import {oidcIssuer} from "./oidc/config"
import {revokeProviderSessionsAndGrants} from "./oidc/mongo-adapter"
import {
  MENTRA_ALG,
  ACCESS_TOKEN_KID,
  RUNTIME_TOKEN_KID,
  MINIAPP_TOKEN_KID,
  ACCOUNT_TOKEN_KID,
  requireEnv,
  getMentraKeys,
  getMiniappKeys,
  getAccountKeys,
} from "./signing-keys.service"

// Key management and the public JWKS moved to signing-keys.service.ts. These
// re-exports keep existing importers (well-known.api, tests) working.
export {getPublicJwks, resetSigningKeyCache, getAccountPublicKeyPem} from "./signing-keys.service"

const logger = createLogger("core").child({service: "session.service"})

// === Token lifetimes ===

const ACCESS_TOKEN_TTL_SEC = 60 * 60 // 1 hour
const RUNTIME_TOKEN_TTL_SEC = 15 * 60 // 15 minutes
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60 // 30 days

const CORE_AUDIENCE = "cloud-core"

// Miniapp-scoped tokens are issued by cloud-core but signed with a separate
// miniapp-token key. Developer backends verify iss/aud/signature via JWKS.
function coreIssuer(): string {
  return process.env.CLOUD_CORE_ISSUER ?? "cloud-core"
}

// The built-in "OEM zero". Mentra's own users (a phone logging in with a
// Supabase session, or a legacy mentra-core token) resolve to this tenantId. It
// has no `oems` record and no JWKS: the subject token is verified with a shared
// HS256 secret, not an OEM public key.
const MENTRA_OEM_ID = "mentra"

// Default miniapp-token lifetime. Env-overridable (MENTRA_MINIAPP_TOKEN_TTL_SEC)
// so tests can shorten it without touching code.
const MINIAPP_TOKEN_DEFAULT_TTL_SEC = 60 * 60 // 1 hour

// Mentra's own first-party account backend signs subject tokens and pushes them
// through the SAME exchange path OEMs use (see issue 019). The `mentra` OEM row
// (startup migration) carries the account public key so verifyTenantJwt verifies
// them. TTL is tiny: the token exists only to cross into createSession.
const ACCOUNT_SUBJECT_TOKEN_TTL_SEC = 60

// === Public API ===

/**
 * Token exchange. Resolves the subject token to an (tenantId, tenantUserId) identity,
 * finds/creates the user, and mints a fresh access + refresh token pair. Returns
 * the RFC 6749 token-response shape.
 *
 * The subject token is one of three kinds, all presented under the single JWT
 * token-type URN and dispatched by `resolveSubjectIdentity`:
 *   - an OEM-signed JWT (verified against the OEM's JWKS), or
 *   - a Mentra Supabase session / legacy mentra-core token (verified with a
 *     shared HS256 secret; tenantId "mentra").
 *
 * Step-by-step matches design.md "Lifecycles / Issue session":
 *   1–5. Delegated to `resolveSubjectIdentity`.
 *   6.   findOrCreateUser by (tenantId, tenantUserId); a deleted account is
 *        refused (`isDeletedAccount`). Core's account login and OAuth go
 *        through here too.
 *   7–8. Mint access + refresh, persist refresh-token hash, return.
 */
export async function createSession(args: {subjectToken: string}): Promise<TokenResponse> {
  const identity = await resolveSubjectIdentity(args.subjectToken)

  const user = await findOrCreateUser({
    tenantId: identity.tenantId,
    tenantUserId: identity.tenantUserId,
  })
  if (isDeletedAccount(user)) throw new InvalidGrant("account is deleted")

  // Burn the subject token's jti BEFORE minting anything. The unique-index
  // insert makes exactly one concurrent presentation win; doing it first means
  // a replayed jti never has tokens minted or persisted for it, so there is no
  // rollback path that can fail and leave a valid session behind.
  if (identity.jti) {
    if (typeof identity.exp !== "number") {
      throw new InvalidGrant("subject_token missing 'exp' claim")
    }
    await recordSeenJti({
      jti: identity.jti,
      tenantId: identity.tenantId,
      expUnixSec: identity.exp,
    })
  }

  const sessionId = `sess_${ulid()}`
  const {token: accessToken} = await issueAccessToken({
    mentraUserId: user.mentraUserId,
    tenantId: identity.tenantId,
    sessionId,
    federatedIdentity: identity.federatedIdentity,
  })
  const refreshToken = await issueRefreshToken({
    sessionId,
    mentraUserId: user.mentraUserId,
    tenantId: identity.tenantId,
    federatedIdentity: identity.federatedIdentity,
  })

  logger.info({sessionId, mentraUserId: user.mentraUserId, tenantId: identity.tenantId}, "session created")

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
  }
}

/**
 * Refresh flow. Hashes the presented refresh token, looks up the session,
 * checks the OEM is still enabled, rotates the stored refresh-token hash in
 * place, and returns fresh access + refresh tokens.
 */
export async function refreshSession(args: {refreshToken: string}): Promise<TokenResponse> {
  const presentedHash = hashRefreshToken(args.refreshToken)

  const now = new Date()
  // Normal path: the presented token is the session's live refresh token.
  // Recovery path (OS-1703): it is the immediate predecessor — the client
  // refreshed, the server rotated, but the response carrying the successor
  // never got persisted (process killed mid-rotation, dropped connection).
  // The predecessor stays honored until the successor is first USED: once a
  // successor is presented it becomes `prevTokenHash` itself, and anything
  // older matches nothing and fails exactly as before.
  let oldDoc = await RefreshTokenModel.findOne({
    refreshTokenHash: presentedHash,
    expiresAt: {$gt: now},
  }).lean()
  if (!oldDoc) {
    oldDoc = await RefreshTokenModel.findOne({
      prevTokenHash: presentedHash,
      expiresAt: {$gt: now},
    }).lean()
  }
  if (!oldDoc) {
    oldDoc = await RefreshTokenModel.findOne({
      altTokenHash: presentedHash,
      expiresAt: {$gt: now},
    }).lean()
  }
  if (!oldDoc) {
    throw new InvalidGrant("refresh_token unknown, expired, or already used")
  }
  if (!oldDoc.sessionId || !oldDoc.mentraUserId || !oldDoc.tenantId) {
    throw new InvalidGrant("refresh_token session identity is incomplete")
  }
  // Deletion revokes the account's refresh tokens; one that slipped past that is refused here.
  if (await isDeletedAccountId(oldDoc.mentraUserId)) throw new InvalidGrant("account is deleted")

  // Mid-session revocation check. If the tenant's authority was terminated
  // after this session was issued, refuse to re-up. The tenant may be an OEM
  // (oems record) or an enterprise trusted-issuer org (enterprise_orgs record);
  // the built-in "mentra" tenant has no backing record and is always allowed.
  await assertTenantStillAuthorized(oldDoc.tenantId)

  // Mint fresh tokens. We reuse the existing sessionId so admin handles
  // remain stable across refreshes.
  const {token: accessToken} = await issueAccessToken({
    mentraUserId: oldDoc.mentraUserId,
    tenantId: oldDoc.tenantId,
    sessionId: oldDoc.sessionId,
    federatedIdentity: normalizeStoredFederatedIdentity(oldDoc.federatedIdentity),
  })
  const nextRefresh = mintRefreshToken()

  // A normal live-token use proves which branch the client persisted: rotate
  // it, retire the grandparent, and collapse any alternate sibling. The same
  // confirmed path handles a presented alternate sibling.
  const confirmedRotation = {
    $set: {
      refreshTokenHash: nextRefresh.hash,
      prevTokenHash: presentedHash,
      issuedAt: now,
      expiresAt: nextRefresh.expiresAt,
    },
    $unset: {altTokenHash: ""},
  }
  let rotated = await RefreshTokenModel.findOneAndUpdate(
    {
      refreshTokenHash: presentedHash,
      expiresAt: {$gt: now},
    },
    confirmedRotation,
  ).lean()
  if (!rotated) {
    // Recovery via the predecessor means either the prior response was lost
    // or a duplicate request raced it. Capture the currently-live successor
    // into altTokenHash atomically before replacing it, so either response the
    // phone persists remains usable instead of causing an unprovoked logout.
    rotated = await RefreshTokenModel.findOneAndUpdate(
      {
        prevTokenHash: presentedHash,
        expiresAt: {$gt: now},
      },
      [
        {
          $set: {
            altTokenHash: "$refreshTokenHash",
            refreshTokenHash: nextRefresh.hash,
            issuedAt: now,
            expiresAt: nextRefresh.expiresAt,
          },
        },
      ],
    ).lean()
  }
  if (!rotated) {
    rotated = await RefreshTokenModel.findOneAndUpdate(
      {
        altTokenHash: presentedHash,
        expiresAt: {$gt: now},
      },
      confirmedRotation,
    ).lean()
  }
  if (!rotated) {
    throw new InvalidGrant("refresh_token unknown, expired, or already used")
  }

  return {
    access_token: accessToken,
    refresh_token: nextRefresh.plaintext,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
  }
}

/**
 * Mid-session revocation guard for the refresh flow. A session's tenant is one
 * of three kinds, each with its own backing record and "still authorized" rule:
 *   - an OEM: allowed while its `oems` row is not disabled. This INCLUDES the
 *     `mentra` tenant, whose account module registers a real oems row (issue
 *     019) so Mentra is validated exactly like any other OEM,
 *   - an enterprise trusted-issuer org: allowed while its `enterprise_orgs` row
 *     has status "active".
 * Enterprise tenants have NO `oems` row (their tenantId comes from EnterpriseOrg,
 * see verifyTrustedIssuerJwt in oem.service), so checking only OemModel would
 * reject every enterprise session on its first refresh once the access token
 * expired. We check OEMs first, then enterprise orgs, then reject.
 *
 * Transitional: environments that predate the account rollout have no `mentra`
 * oems row (the seed migration skips when the account key env is unset), so
 * `mentra` with NO row falls back to allowed. That fallback dies at the V1
 * cutover, at which point mentra is a hard oems-row check like everyone.
 */
async function assertTenantStillAuthorized(tenantId: string): Promise<void> {
  if (isConfiguredOidcTenant(tenantId)) return
  const oem = await OemModel.findOne({tenantId}).lean()
  if (oem) {
    if (oem.disabled) {
      throw new UnauthorizedClient(`oem ${tenantId} unknown or disabled`)
    }
    return
  }
  if (tenantId === MENTRA_OEM_ID) return // transitional fallback, see above

  const enterpriseOrg = await EnterpriseOrgModel.findOne({tenantId}).lean()
  if (enterpriseOrg) {
    if (enterpriseOrg.status !== "active") {
      throw new UnauthorizedClient(`enterprise org ${tenantId} disabled`)
    }
    return
  }

  throw new UnauthorizedClient(`tenant ${tenantId} unknown or disabled`)
}

/**
 * Revoke a single session. The access token used to authorize the logout
 * request is blacklisted first (until its natural expiry), then the refresh
 * token is removed. The order matters: if the blacklist write fails we throw
 * before touching the refresh token, so the caller may safely retry with the
 * still-cryptographically-valid access token instead of being left with a
 * dead refresh token and a live access token. If the refresh-token delete
 * fails after the blacklist write, the error also surfaces; the client can
 * refresh and retry, and the blacklist upsert is idempotent.
 */
export async function revokeSession(args: {
  sessionId: string
  accessToken?: {jti: string; expiresAt: number}
}): Promise<void> {
  if (args.accessToken) {
    await RevokedJtiModel.updateOne(
      {jti: args.accessToken.jti},
      {$set: {expiresAt: new Date(args.accessToken.expiresAt * 1000)}},
      {upsert: true},
    )
  }
  await RefreshTokenModel.deleteOne({sessionId: args.sessionId})
  logger.info({sessionId: args.sessionId}, "session revoked")
}

/**
 * Revoke every session belonging to an OEM. Sets `oems.disabled = true`
 * (which alone blocks future exchanges and refreshes via the disabled
 * checks elsewhere) and deletes all of the OEM's refresh tokens.
 *
 * Does not currently enumerate outstanding access-token jtis into
 * `revokedJtis`. Active access tokens for revoked OEMs remain
 * cryptographically valid until natural expiry (≤1 hour). Tightening this
 * requires storing the access-token jti at issue time so we can blacklist
 * them here.
 */
export async function revokeAllForOem(tenantId: string): Promise<{deletedSessions: number}> {
  await OemModel.updateOne({tenantId}, {$set: {disabled: true}})
  const result = await RefreshTokenModel.deleteMany({tenantId})
  logger.info({tenantId, deletedSessions: result.deletedCount}, "bulk-revoked oem sessions")
  return {deletedSessions: result.deletedCount ?? 0}
}

/**
 * Account-wide revocation (logout-everywhere, password change or reset,
 * account deletion):
 *  1. sets the person's `webSignInsRevokedAt`, so Core refuses their Core
 *     access tokens and sign-ins from before it, and the sign-in page's
 *     hand-off refuses Supabase sessions that started before it (the Store's
 *     next request for them fails);
 *  2. revokes every phone refresh token. `exceptSessionId` keeps the current
 *     phone session alive (e.g. logout-everywhere from the active app without
 *     kicking itself). The access token dies at its natural expiry;
 *  3. ends their portal sessions;
 *  4. ends their sessions and grants at Core's sign-in server: the sign-in
 *     site asks for credentials again and every client's next refresh fails;
 *  5. on hosted Core, ends every Supabase session of the person (best effort,
 *     never blocking: see endIdentityProviderSessions).
 * Step 1 comes first so the web side is closed before anything else runs.
 */
export async function revokeAllSessionsForUser(args: {
  mentraUserId: string
  exceptSessionId?: string
}): Promise<{deletedSessions: number}> {
  const user = await UserModel.findOneAndUpdate(
    {mentraUserId: args.mentraUserId},
    {$set: {webSignInsRevokedAt: new Date()}},
    {new: true},
  ).lean()
  const filter: Record<string, unknown> = {mentraUserId: args.mentraUserId}
  if (args.exceptSessionId) filter.sessionId = {$ne: args.exceptSessionId}
  const result = await RefreshTokenModel.deleteMany(filter)
  await revokePortalSessionsForUser(args.mentraUserId, "account_revocation")
  await revokeProviderSessionsAndGrants(args.mentraUserId)
  if (user) await endIdentityProviderSessions(user)
  return {deletedSessions: result.deletedCount ?? 0}
}

/**
 * Verify a Mentra-issued access token. Returns the parsed claims on
 * success, throws on bad signature / expired / revoked.
 *
 * Auth middleware calls this on inbound requests bearing
 * `Authorization: Bearer <token>`.
 *
 * Delegates signature/claims/expiry to the shared verifier and layers on
 * the core-only Mongo revocation blacklist check.
 */
export type {VerifiedAccessToken} from "@mentra/cloud-shared"

export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
  // Signature + claims + expiry come from shared. Translate the shared error
  // type into the RFC 8693 InvalidGrant the API layer expects.
  let verified: VerifiedAccessToken
  try {
    verified = await verifyAccessTokenSignature(token)
  } catch (err) {
    if (err instanceof AccessTokenError) {
      throw new InvalidGrant(err.message)
    }
    throw err
  }

  // Core-only blacklist check. Session logout writes the authorizing access
  // token's jti here so subsequent Core calls fail immediately. Audio/proxy do
  // not consult Mongo and therefore retain their bounded token lifetime.
  const revoked = await RevokedJtiModel.findOne({jti: verified.jti}).lean()
  if (revoked) throw new InvalidGrant("access_token revoked")

  return verified
}

/**
 * Mint a miniapp-scoped token for one packageName.
 *
 * The caller has already verified the device's access token and read the
 * identity from it (mentraUserId + tenantId). This token is audience-pinned to a
 * single miniapp (`aud = packageName`) and signed with the separate
 * miniapp-token key, so it is only ever valid against that one miniapp's
 * developer backend. It is the only token a miniapp ever holds; the access
 * token never leaves the device.
 *
 * No install or entitlement check happens here: per auth/spec.md, a valid
 * access token plus the requested packageName is sufficient, and the on-device
 * Runtime enforces that a bundle can only request its own packageName.
 *
 * `email` is the caller-resolved verified account email. When present it is
 * stamped as `email` + `email_verified: true` for every miniapp audience; when
 * absent (OEM users, unverified or unavailable) both claims are omitted.
 *
 * TTL defaults to 1h and is env-overridable via MENTRA_MINIAPP_TOKEN_TTL_SEC
 * so tests can shorten it. Returns the token and its absolute expiry as Unix
 * seconds (what the client caches against).
 */
export async function issueMiniappToken(args: {
  mentraUserId: string
  tenantId: string
  packageName: string
  email?: string | null
}): Promise<{token: string; expiresAt: number}> {
  const {privateKey} = await getMiniappKeys()
  const ttlSec = miniappTokenTtlSec()
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec

  const token = await new jose.SignJWT({
    tenantId: args.tenantId,
    ...(args.email ? {email: args.email, email_verified: true} : {}),
  })
    // The `kid` points the developer backend at the miniapp-token public key.
    .setProtectedHeader({alg: MENTRA_ALG, kid: MINIAPP_TOKEN_KID})
    .setIssuer(coreIssuer())
    .setAudience(args.packageName)
    .setSubject(args.mentraUserId)
    .setJti(ulid())
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey)

  return {token, expiresAt}
}

/**
 * Mint a short-lived token for Runtime Services. This is deliberately separate
 * from the Core access token: Runtime verifies `aud=cloud-runtime` locally and
 * never accepts Core/product tokens.
 */
export async function issueRuntimeToken(args: {
  mentraUserId: string
  tenantId: string
  sessionId?: string
  federatedIdentity?: FederatedIdentity
}): Promise<{token: string; expiresAt: number}> {
  const expiresAt = Math.floor(Date.now() / 1000) + RUNTIME_TOKEN_TTL_SEC
  const token = await signRuntimeToken({
    privateKey: requireEnv("MENTRA_JWT_PRIVATE_KEY"),
    issuer: process.env.CLOUD_CORE_RUNTIME_TOKEN_ISSUER ?? coreIssuer(),
    subject: args.mentraUserId,
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    federatedIdentity: args.federatedIdentity,
    jti: ulid(),
    expiresInSeconds: RUNTIME_TOKEN_TTL_SEC,
    kid: RUNTIME_TOKEN_KID,
  })
  return {token, expiresAt}
}

/**
 * Resolve the miniapp-token TTL: the env override if a positive integer is
 * set, otherwise the 1h default. Parsed per call (not cached) so tests can
 * flip it between cases.
 */
function miniappTokenTtlSec(): number {
  const raw = process.env.MENTRA_MINIAPP_TOKEN_TTL_SEC
  if (!raw) return MINIAPP_TOKEN_DEFAULT_TTL_SEC
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MINIAPP_TOKEN_DEFAULT_TTL_SEC
  }
  return Math.floor(parsed)
}

// === Internals: subject-token identity resolution ===

/**
 * Resolve a subject token to an (tenantId, tenantUserId) identity. All three accepted
 * subject tokens arrive as a JWT under the one RFC 8693 JWT token-type URN, so
 * we dispatch on the token itself:
 *   - A Supabase session (its `iss` points at Supabase) resolves to tenantId
 *     "mentra". It is verified by its header `alg`: HS256 with
 *     SUPABASE_JWT_SECRET, or RS256 / ES256 with the project's key set, so the
 *     project can switch to asymmetric signing keys with no Core change.
 *   - Any other HS* (symmetric) token is a legacy mentra-core token
 *     (MENTRA_CORE_JWT_SECRET), also tenantId "mentra".
 *   - Everything else is an OEM-signed JWT, verified against that OEM's JWKS.
 */
async function resolveSubjectIdentity(subjectToken: string): Promise<{
  tenantId: string
  tenantUserId: string
  jti?: string
  exp?: number
  federatedIdentity?: FederatedIdentity
}> {
  let alg: string
  let iss: string | undefined
  try {
    alg = jose.decodeProtectedHeader(subjectToken).alg ?? ""
    const claims = jose.decodeJwt(subjectToken)
    iss = typeof claims.iss === "string" ? claims.iss : undefined
  } catch {
    throw new InvalidRequest("subject_token is not a parseable JWT")
  }

  // Core's sign-in server issues tokens for websites and the CLI; they never become phone tokens.
  if (iss && iss.replace(/\/+$/, "") === oidcIssuer()) {
    throw new InvalidGrant("tokens from Core's sign-in server cannot be exchanged for a phone session")
  }
  if (looksLikeSupabase(iss)) {
    return {tenantId: MENTRA_OEM_ID, tenantUserId: await verifySupabaseSubject(subjectToken, alg)}
  }
  if (alg.startsWith("HS")) {
    const tenantUserId = await verifyHs256Subject(subjectToken, "MENTRA_CORE_JWT_SECRET")
    return {tenantId: MENTRA_OEM_ID, tenantUserId}
  }

  const verified = await verifyTenantJwt(subjectToken)
  return {
    tenantId: verified.tenantId,
    tenantUserId: verified.tenantUserId,
    jti: verified.jti,
    exp: verified.exp,
    federatedIdentity: verified.federatedIdentity,
  }
}

/**
 * A Supabase session JWT carries an `iss` pointing at the project's auth
 * endpoint (e.g. https://<ref>.supabase.co/auth/v1). Match that, or the
 * configured SUPABASE_URL, so we pick the Supabase secret rather than the
 * mentra-core one.
 */
function looksLikeSupabase(iss: string | undefined): boolean {
  if (!iss) return false
  if (iss.includes("supabase.")) return true
  const configured = supabaseIssuer()
  if (configured && iss.replace(/\/+$/, "") === configured) return true
  const supabaseUrl = process.env.SUPABASE_URL
  return !!supabaseUrl && iss.startsWith(supabaseUrl)
}

/**
 * Verify a Supabase session token by its header `alg` and return its `sub`:
 *   - HS256: the project's JWT secret (SUPABASE_JWT_SECRET), as Supabase signs today;
 *   - RS256 / ES256: the project's key set (CLOUD_CORE_SUPABASE_JWKS_URL, by
 *     default `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), with `aud`
 *     "authenticated". An unknown `kid` refreshes the set once. Keys come only
 *     from that set, never from URLs in the token header;
 *   - any other `alg`: refused.
 *
 * Tokens Supabase issued to a web client (they carry `client_id`) are refused:
 * a website's or the CLI's sign-in never becomes a phone session.
 */
async function verifySupabaseSubject(token: string, alg: string): Promise<string> {
  let payload: jose.JWTPayload
  if (alg === "HS256") {
    const key = new TextEncoder().encode(requireEnv("SUPABASE_JWT_SECRET"))
    try {
      ;({payload} = await jose.jwtVerify(token, key, {algorithms: ["HS256"]}))
    } catch (err) {
      throw new InvalidGrant(`subject token verification failed: ${(err as Error).message}`)
    }
  } else if ((SUPABASE_ASYMMETRIC_ALGORITHMS as readonly string[]).includes(alg)) {
    const jwksUrl = supabaseJwksUrl()
    if (!jwksUrl) throw new InvalidGrant("asymmetric Supabase tokens are not configured")
    try {
      ;({payload} = await verifyWithKeySet(token, jwksUrl, {
        algorithms: [...SUPABASE_ASYMMETRIC_ALGORITHMS],
        audience: "authenticated",
      }))
    } catch (err) {
      if (err instanceof KeySetUnavailableError) throw new OauthServerError("Supabase key set unavailable")
      throw new InvalidGrant(`subject token verification failed: ${(err as Error).message}`)
    }
  } else {
    throw new InvalidGrant(`subject token alg ${alg || "none"} is not accepted`)
  }
  if (payload.client_id !== undefined) {
    throw new InvalidGrant("web sign-in tokens cannot be exchanged for a phone session")
  }
  const sub = typeof payload.sub === "string" ? payload.sub : ""
  if (!sub) throw new InvalidGrant("subject token missing 'sub' claim")
  return sub
}

/**
 * Verify a symmetric (HS*) subject token with the named env secret and return
 * its `sub`. Signature + expiry are enforced; we deliberately do not pin
 * `aud`/`iss` (Supabase sets aud "authenticated"), as the shared secret is the
 * trust anchor.
 */
async function verifyHs256Subject(token: string, secretEnv: string): Promise<string> {
  const secret = requireEnv(secretEnv)
  const key = new TextEncoder().encode(secret)
  let payload: jose.JWTPayload
  try {
    ;({payload} = await jose.jwtVerify(token, key, {
      algorithms: ["HS256", "HS384", "HS512"],
    }))
  } catch (err) {
    throw new InvalidGrant(`subject token verification failed: ${(err as Error).message}`)
  }
  const sub = typeof payload.sub === "string" ? payload.sub : ""
  if (!sub) throw new InvalidGrant("subject token missing 'sub' claim")
  return sub
}

// === Internals: Mentra signing keys ===

/**
 * Mint a short-lived Ed25519 subject token for Mentra's first-party account
 * backend, issued under the `mentra` tenant. It is fed straight into
 * createSession, where verifyTenantJwt validates it against the `mentra` OEM
 * row's public key. This is how Mentra dogfoods its own OEM path instead of a
 * bespoke identity branch (issue 019).
 */
export async function mintAccountSubjectToken(args: {tenantUserId: string}): Promise<string> {
  const {privateKey} = await getAccountKeys()
  return (
    new jose.SignJWT({})
      .setProtectedHeader({alg: MENTRA_ALG, kid: ACCOUNT_TOKEN_KID})
      // iss = the OEM tenantId ("mentra"); aud = "mentra", the value the OEM
      // verifier (verifySignatureWithOemKey) pins for all OEM subject tokens.
      .setIssuer(MENTRA_OEM_ID)
      .setAudience(MENTRA_OEM_ID)
      .setSubject(args.tenantUserId)
      .setJti(ulid())
      .setIssuedAt()
      .setExpirationTime(`${ACCOUNT_SUBJECT_TOKEN_TTL_SEC}s`)
      .sign(privateKey)
  )
}

// === Internals: token issuance ===

async function issueAccessToken(args: {
  mentraUserId: string
  tenantId: string
  sessionId: string
  federatedIdentity?: FederatedIdentity
}): Promise<{token: string; jti: string}> {
  const {privateKey} = await getMentraKeys()
  const jti = ulid()
  const claims: jose.JWTPayload = {
    tenant_id: args.tenantId,
    session_id: args.sessionId,
  }
  if (args.federatedIdentity) {
    claims.federated_identity = {
      provider_id: args.federatedIdentity.providerId,
      provider_kind: args.federatedIdentity.providerKind,
      issuer: args.federatedIdentity.issuer,
      subject: args.federatedIdentity.subject,
      ...(args.federatedIdentity.directoryTenantId
        ? {directory_tenant_id: args.federatedIdentity.directoryTenantId}
        : {}),
    }
  }
  const token = await new jose.SignJWT(claims)
    // The `kid` points verifiers at the access-token public key in the JWKS.
    .setProtectedHeader({alg: MENTRA_ALG, kid: ACCESS_TOKEN_KID})
    .setIssuer(coreIssuer())
    .setAudience(CORE_AUDIENCE)
    .setSubject(args.mentraUserId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .sign(privateKey)
  return {token, jti}
}

async function issueRefreshToken(args: {
  sessionId: string
  mentraUserId: string
  tenantId: string
  federatedIdentity?: FederatedIdentity
}): Promise<string> {
  const token = mintRefreshToken()

  await RefreshTokenModel.create({
    sessionId: args.sessionId,
    refreshTokenHash: token.hash,
    mentraUserId: args.mentraUserId,
    tenantId: args.tenantId,
    ...(args.federatedIdentity ? {federatedIdentity: args.federatedIdentity} : {}),
    issuedAt: new Date(),
    expiresAt: token.expiresAt,
  })

  return token.plaintext
}

function normalizeStoredFederatedIdentity(
  value: Record<string, unknown> | null | undefined,
): FederatedIdentity | undefined {
  if (!value) return undefined
  const providerId = typeof value.providerId === "string" ? value.providerId : undefined
  const providerKind = typeof value.providerKind === "string" ? value.providerKind : undefined
  const issuer = typeof value.issuer === "string" ? value.issuer : undefined
  const subject = typeof value.subject === "string" ? value.subject : undefined
  if (!providerId || !providerKind || !issuer || !subject) return undefined
  const directoryTenantId = typeof value.directoryTenantId === "string" ? value.directoryTenantId : undefined
  return {
    providerId,
    providerKind,
    issuer,
    subject,
    ...(directoryTenantId ? {directoryTenantId} : {}),
  }
}

function mintRefreshToken(): {
  plaintext: string
  hash: string
  expiresAt: Date
} {
  // 32 bytes of randomness, base64url-encoded → ~43 chars, 256 bits entropy.
  const plaintext = crypto.randomBytes(32).toString("base64url")
  return {
    plaintext,
    hash: hashRefreshToken(plaintext),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
  }
}

/**
 * HMAC-SHA256 the plaintext refresh token with a server-side pepper.
 *
 * Why HMAC, not argon2/bcrypt: the input is a 256-bit random string, not a
 * low-entropy human password. There is nothing to "slow down brute force"
 * against — forging the input from the hash would require 2^256 work
 * already. The HMAC's job is to make a DB-only leak unusable (because the
 * attacker doesn't have the pepper, which lives in env, not in Mongo).
 */
function hashRefreshToken(plaintext: string): string {
  const pepper = requireEnv("REFRESH_TOKEN_PEPPER")
  return crypto.createHmac("sha256", pepper).update(plaintext).digest("base64url")
}
