/**
 * @fileoverview Sign-in for Core's portal websites (the admin portal and the
 * workspace portal), as confidential clients of Core's own sign-in server
 * (its OpenID Connect provider, `services/oidc`), on hosted Core and on a
 * Private Cloud alike.
 *
 * The flow is the authorization code flow with S256 PKCE, `state` and
 * `nonce`, scope `openid email profile`, and `client_secret_post`. Each
 * portal's client is the first-party client of its kind in
 * `CLOUD_CORE_OIDC_CLIENTS` (`admin_portal`, `workspace_portal`), and its
 * redirect URI, `<portal origin>/api/<portal>/auth/callback`, must be
 * registered there exactly.
 *
 * Core learns who signed in only from the code exchange: the ID token is
 * verified by openid-client and again with jose against Core's own key
 * (`kid` mentra-oidc-1): `iss` equal to `CLOUD_CORE_OIDC_ISSUER`, `aud` equal
 * to the portal's client ID (and `azp` when `aud` has several values),
 * `nonce`, expiry. Its `sub` is the person's `mentraUserId`. The portal keeps
 * no tokens: it requests no refresh token and stores only its own session.
 *
 * Redirect and callback URLs come only from configuration, never from `Host`
 * or forwarding headers. The browser holds only the portal's own session
 * cookie (`__Host-` prefixed, HttpOnly, Secure, SameSite=Lax, Path=/, no
 * Domain). Sign-out ends that session and offers the provider's end-session
 * endpoint, the sign-in site's sign-out.
 */

import {createLogger} from "@mentra/cloud-shared"
import type {Context} from "hono"
import {deleteCookie, getCookie, setCookie} from "hono/cookie"
import * as client from "openid-client"

import * as jose from "jose"

import type {AppEnv} from "../../types/hono.types"
import {loadAccount} from "../oidc/account"
import {clientOfKind, clientSecret} from "../oidc/clients"
import {allowsInsecureIssuer, endSessionUrl, oidcIssuer} from "../oidc/config"
import {OIDC_TOKEN_ALG, OIDC_TOKEN_KID, oidcVerificationKey} from "../oidc/keys"
import {ConfigurationError} from "./config"
import {
  createPortalSession,
  revokePortalSession,
  SESSION_ABSOLUTE_MS,
  type PortalKind,
  type SessionIdentity,
} from "./browser-session.service"
import {consumeLoginTransaction, LOGIN_TRANSACTION_TTL_MS, startLoginTransaction} from "./login-transaction.service"
import {s256} from "./random"
import {consumeRateLimit} from "./rate-limit.service"
import {safeReturnTo} from "./return-to"

const logger = createLogger("core").child({service: "portal-signin"})

const PORTAL_SCOPE = "openid email profile"
const DISCOVERY_TTL_MS = 60 * 60_000
const ID_TOKEN_CLOCK_TOLERANCE_SEC = 30
const LOGIN_LIMIT_PER_MINUTE = 20
const CALLBACK_LIMIT_PER_MINUTE = 30

type C = Context<AppEnv>

/** A portal website as Core serves it: its origin and session cookie, from its configured URL alone. */
export interface PortalSite {
  portal: PortalKind
  /** The portal's origin, from configuration. */
  origin: string
  cookieName: string
  /** HTTPS portal: `__Host-` cookies with Secure. A local HTTP portal drops both. */
  secureCookies: boolean
}

/** The portal's client at Core's sign-in server. */
export interface PortalClient extends PortalSite {
  /** Core's sign-in server: the issuer the portal signs in with. */
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

function clean(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * The portal's site from `CLOUD_CORE_ADMIN_PORTAL_URL` or
 * `CLOUD_CORE_ENTERPRISE_PORTAL_URL`, or null when unset. Sessions, sign-out
 * and the CSRF check need only this.
 */
export function portalSite(portal: PortalKind): PortalSite | null {
  const url = portal === "admin" ? clean(process.env.CLOUD_CORE_ADMIN_PORTAL_URL) : clean(process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL)
  if (!url) return null
  const origin = new URL(url).origin
  const secureCookies = origin.startsWith("https:")
  return {portal, origin, cookieName: secureCookies ? `__Host-mentra_${portal}_session` : `mentra_${portal}_session`, secureCookies}
}

/**
 * The portal's client at Core's sign-in server, from configuration. Throws
 * ConfigurationError when this portal's sign-in is not configured: no issuer,
 * no portal URL, no client of its kind, or its callback not registered.
 */
export function portalClient(portal: PortalKind): PortalClient {
  const issuer = oidcIssuer()
  const site = portalSite(portal)
  const client = clientOfKind(portal === "admin" ? "admin_portal" : "workspace_portal")
  const secret = client ? clientSecret(client) : null
  if (!issuer || !site || !client || !secret) throw new ConfigurationError(`${portal} portal sign-in is not configured`)
  const redirectUri = `${site.origin}/api/${portal}/auth/callback`
  if (!client.redirectUris.includes(redirectUri)) {
    throw new ConfigurationError(`${portal} portal sign-in: client "${client.clientId}" does not register ${redirectUri}`)
  }
  return {...site, issuer, clientId: client.clientId, clientSecret: secret, redirectUri}
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
export function setPortalSessionCookie(c: C, pc: PortalSite, value: string): void {
  setCookie(c, pc.cookieName, value, cookieOptions(pc.secureCookies, Math.floor(SESSION_ABSOLUTE_MS / 1000)))
}

// --- discovery -----------------------------------------------------------------

const configurations = new Map<string, {config: client.Configuration; expiresAt: number}>()

/** Forget cached discovery results (tests, and a changed configuration). */
export function resetPortalSigninCaches(): void {
  configurations.clear()
}

/**
 * Core's sign-in server's configuration for this portal's client, discovered
 * from the issuer and cached for an hour. Plain HTTP is allowed only for a
 * loopback issuer on an undeployed Core.
 */
async function oidcConfiguration(pc: PortalClient): Promise<client.Configuration> {
  const key = `${pc.issuer}|${pc.clientId}`
  const cached = configurations.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.config
  const insecure = allowsInsecureIssuer(pc.issuer)
  const config = await client.discovery(
    new URL(pc.issuer),
    pc.clientId,
    {client_secret: pc.clientSecret, id_token_signed_response_alg: OIDC_TOKEN_ALG},
    client.ClientSecretPost(pc.clientSecret),
    insecure ? {execute: [client.allowInsecureRequests]} : undefined,
  )
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
  const pc = portalClientIfConfigured(portal)
  if (!pc) return notConfigured(c, portal)
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
    config = await oidcConfiguration(pc)
  } catch (err) {
    logger.error({errorName: (err as Error)?.name, code: (err as {code?: string})?.code}, "sign-in server discovery failed")
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
  const authorizationUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: pc.redirectUri,
    scope: PORTAL_SCOPE,
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: s256(tx.pkceVerifier),
    code_challenge_method: "S256",
  })
  setCookie(c, txCookieName(pc.secureCookies), cookieValue, cookieOptions(pc.secureCookies, Math.floor(LOGIN_TRANSACTION_TTL_MS / 1000)))
  c.header("cache-control", "no-store")
  return c.redirect(authorizationUrl.href, 302)
}

export class SignInRefused extends Error {
  override name = "SignInRefused"
}

/** `GET /api/{admin,portal}/auth/callback`: redeem the code and start a portal session. */
export async function finishPortalSignIn(c: C, portal: PortalKind): Promise<Response> {
  const pc = portalClientIfConfigured(portal)
  if (!pc) return notConfigured(c, portal)

  try {
    if (!(await consumeRateLimit(`portal-callback:${portal}:ip:${clientIp(c)}`, CALLBACK_LIMIT_PER_MINUTE, 60))) {
      return tooMany(c, portal)
    }
    const txCookie = getCookie(c, txCookieName(pc.secureCookies))
    const state = c.req.query("state")
    if (!txCookie || !state) throw new SignInRefused("missing sign-in transaction")
    const tx = await consumeLoginTransaction(txCookie, state)
    if (!tx || tx.portal !== portal) throw new SignInRefused("unknown, used or expired sign-in transaction")

    const config = await oidcConfiguration(pc)
    // The callback URL Core verifies is its configured redirect URI with the
    // query string the provider sent, never one built from request headers.
    const callbackUrl = new URL(pc.redirectUri)
    callbackUrl.search = new URL(c.req.url).search
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: tx.pkceVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    })
    const identity = await verifyPortalIdToken(pc, tokens.id_token, tx.nonce)

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
    // openid-client protocol errors (bad state, a refused code, an ID token
    // that fails its checks) are refusals; the sign-in server answering 5xx, a
    // network failure or a database failure is an outage, and every failure
    // fails closed.
    const providerStatus = upstreamStatus(err)
    const protocolError = err instanceof client.ClientError || (typeof code === "string" && code.startsWith("OAUTH_"))
    if (protocolError && !(providerStatus !== undefined && providerStatus >= 500)) {
      logger.warn({portal, code, errorName: (err as Error).name}, "portal sign-in refused by the code exchange")
      return signInFailed(c, portal)
    }
    logger.error({portal, errorName: (err as Error)?.name, code}, "portal sign-in failed")
    return signInFailed(c, portal, 503)
  }
}

/** The HTTP status of the sign-in server's response behind an openid-client error, when there is one. */
function upstreamStatus(err: unknown): number | undefined {
  const error = err as {status?: unknown; cause?: unknown}
  if (typeof error?.status === "number") return error.status
  if (error?.cause instanceof Response) return error.cause.status
  return undefined
}

/**
 * The person behind the ID token from the portal's code exchange, verified
 * again with Core's own key: header `kid` mentra-oidc-1 and no `at+jwt` type,
 * `iss`, `aud` (and `azp`), `nonce` and expiry. Core must still accept the
 * person: not deleted, not signed in before their revocation, from a source
 * still configured.
 */
export async function verifyPortalIdToken(pc: PortalClient, idToken: string | undefined, nonce: string): Promise<SessionIdentity> {
  if (!idToken) throw new SignInRefused("no ID token")
  let payload: jose.JWTPayload
  try {
    const header = jose.decodeProtectedHeader(idToken)
    const typ: unknown = header.typ
    if (header.kid !== OIDC_TOKEN_KID || (typ !== undefined && (typeof typ !== "string" || typ.toUpperCase() !== "JWT"))) {
      throw new SignInRefused("ID token header refused")
    }
    ;({payload} = await jose.jwtVerify(idToken, await oidcVerificationKey(), {
      issuer: pc.issuer,
      audience: pc.clientId,
      algorithms: [OIDC_TOKEN_ALG],
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SEC,
      requiredClaims: ["sub", "iat", "exp"],
    }))
  } catch (err) {
    if (err instanceof SignInRefused) throw err
    throw new SignInRefused("ID token refused")
  }
  if (payload.nonce !== nonce) throw new SignInRefused("ID token nonce mismatch")
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== pc.clientId) throw new SignInRefused("ID token azp mismatch")
  const mentraUserId = payload.sub!
  const authTimeSec = typeof payload.auth_time === "number" ? payload.auth_time : (payload.iat as number)
  const account = await loadAccount(mentraUserId, authTimeSec)
  if (!account) throw new SignInRefused("the person is no longer accepted")
  return {
    mentraUserId,
    tenantId: account.tenantId,
    sourceId: account.sourceId,
    subject: account.subject,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true,
    authTime: new Date(authTimeSec * 1000),
  }
}

/** `POST /api/{admin,portal}/auth/logout`: end the portal session; offer the identity provider's sign-out. */
export async function signOutPortal(c: C, portal: PortalKind): Promise<Response> {
  c.header("cache-control", "no-store")
  const pc = portalSite(portal)
  if (!pc) return c.json({error: "not_configured", error_description: "portal sign-in is not configured"}, 503)
  if (!isSameOrigin(c, pc.origin)) return c.json({error: "forbidden", error_description: "cross-origin request refused"}, 403)
  const value = getCookie(c, pc.cookieName)
  if (value) await revokePortalSession(value, "sign_out")
  deleteCookie(c, pc.cookieName, {path: "/", secure: pc.secureCookies})
  return c.json({signOutUrl: endSessionUrl()})
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
