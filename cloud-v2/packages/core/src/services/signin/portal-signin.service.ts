/**
 * @fileoverview Sign-in for Core's portal websites (the admin portal and the
 * enterprise portal), as confidential OpenID Connect clients of the
 * deployment's identity provider.
 *
 * The flow is the authorization code flow with S256 PKCE and `state`:
 *  - hosted Core (Supabase): scope `email profile`, never `openid` (on an
 *    HS256 project the code exchange then fails with HTTP 500 and leaves an
 *    orphaned session). Core learns who signed in from the access token in its
 *    own code exchange, verified like any identity-provider token, and
 *    requires it to be issued to this portal's client. Core then ends that
 *    Supabase session (`POST {issuer}/logout?scope=local`): the portal keeps no
 *    Supabase tokens, so the session has no further use. The sign-in page's
 *    own session, which carries single sign-on, is separate and continues;
 *  - a Private Cloud provider (Entra): scope from its browser settings
 *    (`openid email profile`) plus `nonce`; the ID token is re-verified with
 *    jose against the pinned key set (issuer, audience, `azp`, algorithms,
 *    nonce, directory tenant, subject claim).
 * Confidential clients authenticate with `client_secret_post`: Supabase
 * refuses openid-client's `client_secret_basic`.
 *
 * Redirect and callback URLs come only from configuration, never from `Host`
 * or forwarding headers. Tokens never reach the browser: it holds only the
 * portal's own session cookie (`__Host-` prefixed, HttpOnly, Secure,
 * SameSite=Lax, Path=/, no Domain).
 */

import {createLogger} from "@mentra/cloud-shared"
import type {Context} from "hono"
import {deleteCookie, getCookie, setCookie} from "hono/cookie"
import * as client from "openid-client"

import {UserModel} from "../../models/user.model"
import type {AppEnv} from "../../types/hono.types"
import {findOrCreateUser} from "../user.service"
import {
  ConfigurationError,
  isDeployedEnvironment,
  portalIdentityProvider,
  type WebIdentityProvider,
} from "./config"
import {
  createPortalSession,
  revokePortalSession,
  SESSION_ABSOLUTE_MS,
  type PortalKind,
  type SessionIdentity,
} from "./browser-session.service"
import {trustedEmail} from "./email-trust"
import {IdentityProviderUnavailableError, verifyIdpAccessToken} from "./idp-tokens"
import {KeySetUnavailableError, verifyWithKeySet} from "./key-sets"
import {consumeLoginTransaction, LOGIN_TRANSACTION_TTL_MS, startLoginTransaction} from "./login-transaction.service"
import {s256} from "./random"
import {consumeRateLimit} from "./rate-limit.service"
import {safeReturnTo} from "./return-to"

const logger = createLogger("core").child({service: "portal-signin"})

const SUPABASE_SCOPE = "email profile"
const DISCOVERY_TTL_MS = 60 * 60_000
const ID_TOKEN_CLOCK_TOLERANCE_SEC = 30
const LOGIN_LIMIT_PER_MINUTE = 20
const CALLBACK_LIMIT_PER_MINUTE = 30

type C = Context<AppEnv>

export interface PortalClient {
  portal: PortalKind
  clientId: string
  clientSecret: string
  /** The portal's origin, from configuration. */
  origin: string
  redirectUri: string
  cookieName: string
  /** HTTPS portal: `__Host-` cookies with Secure. A local HTTP portal drops both. */
  secureCookies: boolean
}

function clean(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * The portal's client registration and URLs, from configuration. Throws
 * ConfigurationError when this portal's sign-in is not configured.
 *  - Hosted (Supabase): CLOUD_CORE_{ADMIN,ENTERPRISE}_PORTAL_{URL,CLIENT_ID,CLIENT_SECRET}.
 *  - Private Cloud: the admin portal uses the provider's browser settings and
 *    CLOUD_CORE_ADMIN_PORTAL_URL; the enterprise portal is a hosted product.
 */
export function portalClient(portal: PortalKind, provider: WebIdentityProvider = portalIdentityProvider()): PortalClient {
  const url = portal === "admin" ? clean(process.env.CLOUD_CORE_ADMIN_PORTAL_URL) : clean(process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL)
  let clientId: string
  let clientSecret: string
  if (provider.kind === "supabase") {
    clientId =
      portal === "admin"
        ? clean(process.env.CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID)
        : clean(process.env.CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID)
    clientSecret =
      portal === "admin"
        ? clean(process.env.CLOUD_CORE_ADMIN_PORTAL_CLIENT_SECRET)
        : clean(process.env.CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_SECRET)
  } else {
    if (portal !== "admin" || !provider.browser) throw new ConfigurationError(`${portal} portal sign-in is not configured`)
    clientId = provider.browser.clientId
    clientSecret = clean(process.env[provider.browser.clientSecretEnv])
  }
  if (!url || !clientId || !clientSecret) throw new ConfigurationError(`${portal} portal sign-in is not configured`)
  const origin = new URL(url).origin
  const secureCookies = origin.startsWith("https:")
  return {
    portal,
    clientId,
    clientSecret,
    origin,
    redirectUri: `${origin}/api/${portal}/auth/callback`,
    cookieName: secureCookies ? `__Host-mentra_${portal}_session` : `mentra_${portal}_session`,
    secureCookies,
  }
}

/** The portal's client, or null when its sign-in is not configured. */
export function portalClientIfConfigured(portal: PortalKind): PortalClient | null {
  try {
    return portalClient(portal)
  } catch (err) {
    if (err instanceof ConfigurationError) return null
    throw err
  }
}

function txCookieName(secure: boolean): string {
  return secure ? "__Host-mentra_client_tx" : "mentra_client_tx"
}

function cookieOptions(secure: boolean, maxAgeSec: number) {
  return {httpOnly: true, secure, sameSite: "Lax" as const, path: "/", maxAge: maxAgeSec}
}

/** Set (or rotate) the portal's session cookie. */
export function setPortalSessionCookie(c: C, pc: PortalClient, value: string): void {
  setCookie(c, pc.cookieName, value, cookieOptions(pc.secureCookies, Math.floor(SESSION_ABSOLUTE_MS / 1000)))
}

// --- after-sign-in hooks ---------------------------------------------------------

export type AfterSignInHook = (identity: SessionIdentity) => Promise<void>
const afterSignInHooks: AfterSignInHook[] = []

/** Run `hook` after every portal sign-in. A throwing hook is logged and never blocks sign-in. */
export function registerAfterSignInHook(hook: AfterSignInHook): void {
  afterSignInHooks.push(hook)
}

async function runAfterSignInHooks(identity: SessionIdentity): Promise<void> {
  for (const hook of afterSignInHooks) {
    try {
      await hook(identity)
    } catch (err) {
      logger.error({errorName: (err as Error)?.name}, "after-sign-in hook failed")
    }
  }
}

// --- discovery -----------------------------------------------------------------

const configurations = new Map<string, {config: client.Configuration; expiresAt: number}>()

/** Forget cached discovery results (tests, and a changed configuration). */
export function resetPortalSigninCaches(): void {
  configurations.clear()
}

function allowsInsecureIssuer(issuer: string): boolean {
  if (isDeployedEnvironment()) return false
  const url = new URL(issuer)
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
}

/**
 * The provider's OpenID configuration for this client, discovered from its
 * issuer and cached for an hour, with `jwks_uri` pinned to the configured key
 * set. Plain HTTP is allowed only for a loopback issuer on an undeployed Core.
 */
async function oidcConfiguration(provider: WebIdentityProvider, pc: PortalClient): Promise<client.Configuration> {
  const key = `${provider.issuer}|${pc.clientId}`
  const cached = configurations.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.config
  const insecure = allowsInsecureIssuer(provider.issuer)
  const auth = client.ClientSecretPost(pc.clientSecret)
  const discovered = await client.discovery(
    new URL(provider.issuer),
    pc.clientId,
    {client_secret: pc.clientSecret},
    auth,
    insecure ? {execute: [client.allowInsecureRequests]} : undefined,
  )
  const metadata = JSON.parse(JSON.stringify(discovered.serverMetadata())) as client.ServerMetadata
  const config = new client.Configuration({...metadata, jwks_uri: provider.jwksUrl}, pc.clientId, {client_secret: pc.clientSecret}, auth)
  if (insecure) client.allowInsecureRequests(config)
  configurations.set(key, {config, expiresAt: Date.now() + DISCOVERY_TTL_MS})
  return config
}

// --- pages -----------------------------------------------------------------------

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

/** A fixed-text page on the portal's origin. Never echoes request parameters. */
function page(c: C, status: 400 | 429 | 503, portal: PortalKind, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body>
<main>
<h1>${title}</h1>
<p>${body}</p>
<p><a href="/api/${portal}/auth/login">Try again</a></p>
</main>
</body>
</html>
`
  for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value)
  return c.body(html, status)
}

const signInFailed = (c: C, portal: PortalKind, status: 400 | 503 = 400) =>
  page(c, status, portal, "Sign-in did not complete", "Your sign-in could not be completed. Start again from the portal.")
const notConfigured = (c: C, portal: PortalKind) =>
  page(c, 503, portal, "Sign-in is not configured", "Sign-in for this portal is not configured on this deployment.")
const unavailable = (c: C, portal: PortalKind) =>
  page(c, 503, portal, "Sign-in is unavailable", "The sign-in service could not be reached. Try again in a moment.")
const tooMany = (c: C, portal: PortalKind) =>
  page(c, 429, portal, "Too many attempts", "Too many sign-in attempts from this network. Wait a minute and try again.")

/** The caller's IP for rate limits: the first `x-forwarded-for` hop (the ingress sets it). */
function clientIp(c: C): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
}

// --- routes -----------------------------------------------------------------------

/** `GET /api/{admin,portal}/auth/login?return_to`: start the code flow. */
export async function startPortalSignIn(c: C, portal: PortalKind): Promise<Response> {
  let provider: WebIdentityProvider
  let pc: PortalClient
  try {
    provider = portalIdentityProvider()
    pc = portalClient(portal, provider)
  } catch (err) {
    if (err instanceof ConfigurationError) return notConfigured(c, portal)
    throw err
  }
  try {
    if (!(await consumeRateLimit(`portal-login:${portal}:ip:${clientIp(c)}`, LOGIN_LIMIT_PER_MINUTE, 60))) {
      return tooMany(c, portal)
    }
  } catch (err) {
    logger.error({errorName: (err as Error)?.name}, "portal sign-in rate limit unavailable")
    return unavailable(c, portal)
  }

  let config: client.Configuration
  try {
    config = await oidcConfiguration(provider, pc)
  } catch (err) {
    logger.error({errorName: (err as Error)?.name, code: (err as {code?: string})?.code}, "identity provider discovery failed")
    return unavailable(c, portal)
  }

  let started
  try {
    started = await startLoginTransaction(portal, safeReturnTo(c.req.query("return_to")))
  } catch (err) {
    logger.error({errorName: (err as Error)?.name}, "could not start a portal sign-in")
    return unavailable(c, portal)
  }
  const {cookieValue, tx} = started
  const parameters: Record<string, string> = {
    redirect_uri: pc.redirectUri,
    state: tx.state,
    code_challenge: s256(tx.pkceVerifier),
    code_challenge_method: "S256",
  }
  if (provider.kind === "supabase") {
    parameters.scope = SUPABASE_SCOPE
  } else {
    parameters.scope = provider.browser!.scopes.join(" ")
    parameters.nonce = tx.nonce
  }
  const authorizationUrl = client.buildAuthorizationUrl(config, parameters)
  setCookie(c, txCookieName(pc.secureCookies), cookieValue, cookieOptions(pc.secureCookies, Math.floor(LOGIN_TRANSACTION_TTL_MS / 1000)))
  c.header("cache-control", "no-store")
  return c.redirect(authorizationUrl.href, 302)
}

class SignInRefused extends Error {
  override name = "SignInRefused"
}

/** `GET /api/{admin,portal}/auth/callback`: redeem the code and start a portal session. */
export async function finishPortalSignIn(c: C, portal: PortalKind): Promise<Response> {
  let provider: WebIdentityProvider
  let pc: PortalClient
  try {
    provider = portalIdentityProvider()
    pc = portalClient(portal, provider)
  } catch (err) {
    if (err instanceof ConfigurationError) return notConfigured(c, portal)
    throw err
  }

  try {
    if (!(await consumeRateLimit(`portal-callback:${portal}:ip:${clientIp(c)}`, CALLBACK_LIMIT_PER_MINUTE, 60))) {
      return tooMany(c, portal)
    }
    const txCookie = getCookie(c, txCookieName(pc.secureCookies))
    const state = c.req.query("state")
    if (!txCookie || !state) throw new SignInRefused("missing sign-in transaction")
    const tx = await consumeLoginTransaction(txCookie, state)
    if (!tx || tx.portal !== portal) throw new SignInRefused("unknown, used or expired sign-in transaction")

    const config = await oidcConfiguration(provider, pc)
    // The callback URL Core verifies is its configured redirect URI with the
    // query string the provider sent, never one built from request headers.
    const callbackUrl = new URL(pc.redirectUri)
    callbackUrl.search = new URL(c.req.url).search
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: tx.pkceVerifier,
      expectedState: tx.state,
      ...(provider.kind === "oidc_provider" ? {expectedNonce: tx.nonce, idTokenExpected: true} : {}),
    })

    const identity =
      provider.kind === "supabase"
        ? await supabaseSignIn(provider, pc, tokens.access_token)
        : await providerSignIn(provider, pc, tokens.id_token, tx.nonce)

    await runAfterSignInHooks(identity)
    const {cookieValue} = await createPortalSession(portal, identity)
    setPortalSessionCookie(c, pc, cookieValue)
    deleteCookie(c, txCookieName(pc.secureCookies), {path: "/", secure: pc.secureCookies})
    logger.info({portal, mentraUserId: identity.mentraUserId, tenantId: identity.tenantId}, "portal sign-in")
    c.header("cache-control", "no-store")
    return c.redirect(tx.returnTo, 302)
  } catch (err) {
    if (err instanceof SignInRefused) {
      logger.warn({portal, reason: err.message}, "portal sign-in refused")
      return signInFailed(c, portal)
    }
    const code = (err as {code?: string})?.code
    // openid-client protocol errors (bad state, a refused code, a malformed
    // response) are refusals; a provider answering 5xx, a network failure or a
    // database failure is an outage, and every failure fails closed.
    const providerStatus = upstreamStatus(err)
    const protocolError = err instanceof client.ClientError || (typeof code === "string" && code.startsWith("OAUTH_"))
    if (protocolError && !(providerStatus !== undefined && providerStatus >= 500)) {
      logger.warn({portal, code, errorName: (err as Error).name}, "portal sign-in refused by the identity provider exchange")
      return signInFailed(c, portal)
    }
    logger.error({portal, errorName: (err as Error)?.name, code}, "portal sign-in failed")
    return signInFailed(c, portal, 503)
  }
}

/** The HTTP status of the identity provider response behind an openid-client error, when there is one. */
function upstreamStatus(err: unknown): number | undefined {
  const error = err as {status?: unknown; cause?: unknown}
  if (typeof error?.status === "number") return error.status
  if (error?.cause instanceof Response) return error.cause.status
  return undefined
}

async function supabaseSignIn(provider: WebIdentityProvider, pc: PortalClient, accessToken: string): Promise<SessionIdentity> {
  // An outage (IdentityProviderUnavailableError) propagates and fails closed with 503.
  const identity = await verifyIdpAccessToken(accessToken)
  if (!identity || identity.clientId !== pc.clientId) throw new SignInRefused("access token refused")
  await endSupabaseSession(provider, accessToken)
  return {
    mentraUserId: identity.mentraUserId,
    tenantId: identity.tenantId,
    sourceId: provider.sourceId,
    subject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    authTime: identity.sessionStartedAt ?? new Date(),
  }
}

/**
 * End the Supabase session from the portal's code exchange
 * (`POST {issuer}/logout?scope=local` with that access token, and the
 * publishable key for Supabase's gateway). Best effort: a failure is logged
 * and never blocks sign-in.
 */
async function endSupabaseSession(provider: WebIdentityProvider, accessToken: string): Promise<void> {
  try {
    const headers: Record<string, string> = {authorization: `Bearer ${accessToken}`}
    const publishable = clean(process.env.SUPABASE_ANON_KEY)
    if (publishable) headers.apikey = publishable
    const response = await fetch(`${provider.issuer}/logout?scope=local`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (response.status !== 204) logger.warn({status: response.status}, "could not end the portal's Supabase session")
  } catch (err) {
    logger.warn({errorName: (err as Error)?.name}, "could not end the portal's Supabase session")
  }
}

async function providerSignIn(
  provider: WebIdentityProvider,
  pc: PortalClient,
  idToken: string | undefined,
  nonce: string,
): Promise<SessionIdentity> {
  if (!idToken) throw new SignInRefused("no ID token")
  let payload
  try {
    ;({payload} = await verifyWithKeySet(idToken, provider.jwksUrl, {
      issuer: provider.issuer,
      audience: pc.clientId,
      algorithms: provider.algorithms,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SEC,
    }))
  } catch (err) {
    if (err instanceof KeySetUnavailableError) throw new IdentityProviderUnavailableError(err.message)
    throw new SignInRefused("ID token refused")
  }
  if (payload.nonce !== nonce) throw new SignInRefused("ID token nonce mismatch")
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== pc.clientId) {
    throw new SignInRefused("ID token azp mismatch")
  }
  if (provider.expectedDirectoryTenantId) {
    const directoryTenant = provider.directoryTenantClaim ? payload[provider.directoryTenantClaim] : undefined
    if (directoryTenant !== provider.expectedDirectoryTenantId) throw new SignInRefused("ID token directory tenant mismatch")
  }
  const subject = payload[provider.subjectClaim]
  if (typeof subject !== "string" || !subject) throw new SignInRefused("ID token has no subject")
  const email = trustedEmail({
    provider,
    email: payload[provider.browser?.emailClaim ?? "email"],
    tokenEmailVerified: payload.email_verified,
  })
  const user = await findOrCreateUser({tenantId: provider.tenantId, tenantUserId: subject})
  const revokedAt = (await UserModel.findOne({mentraUserId: user.mentraUserId}, {webSignInsRevokedAt: 1}).lean())?.webSignInsRevokedAt
  const issuedAt = typeof payload.iat === "number" ? new Date(payload.iat * 1000) : new Date()
  if (revokedAt && issuedAt.getTime() < revokedAt.getTime()) throw new SignInRefused("sign-in from before a revocation")
  return {
    mentraUserId: user.mentraUserId,
    tenantId: provider.tenantId,
    sourceId: provider.sourceId,
    subject,
    email: email.email,
    emailVerified: email.verified,
    authTime: issuedAt,
  }
}

/** `POST /api/{admin,portal}/auth/logout`: end the portal session; offer the identity provider's sign-out. */
export async function signOutPortal(c: C, portal: PortalKind): Promise<Response> {
  c.header("cache-control", "no-store")
  const pc = portalClientIfConfigured(portal)
  if (!pc) return c.json({error: "not_configured", error_description: "portal sign-in is not configured"}, 503)
  if (!isSameOrigin(c, pc.origin)) return c.json({error: "forbidden", error_description: "cross-origin request refused"}, 403)
  const value = getCookie(c, pc.cookieName)
  if (value) await revokePortalSession(value, "sign_out")
  deleteCookie(c, pc.cookieName, {path: "/", secure: pc.secureCookies})
  return c.json({signOutUrl: clean(process.env.CLOUD_CORE_IDP_SIGNOUT_URL) || null})
}

/**
 * CSRF check for an unsafe request: `Origin` must be the portal's origin, or,
 * when `Origin` is absent, `Sec-Fetch-Site` must be `same-origin`.
 */
export function isSameOrigin(c: C, origin: string): boolean {
  const requestOrigin = c.req.header("origin")
  if (requestOrigin !== undefined) return requestOrigin === origin
  return c.req.header("sec-fetch-site") === "same-origin"
}
