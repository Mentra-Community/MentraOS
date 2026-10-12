/**
 * @fileoverview Shared setup for Core's web sign-in suites: environment
 * fixtures for hosted Core (Supabase behind Core's sign-in server) and a
 * Private Cloud (Entra behind it, on Core's one host), cookie helpers, a
 * driver for a full portal sign-in through Core's provider, and Core access
 * tokens for people.
 */

import {randomUUID} from "node:crypto"

import {expect} from "bun:test"
import type {Hono} from "hono"
import * as jose from "jose"

import {SigninIdentityModel} from "../../packages/core/src/models/signin-identity.model"
import {findOrCreateUser} from "../../packages/core/src/services/user.service"
import type {FakeIdp, FakePerson} from "./fake-idp"
import {Browser, CLIENTS, CLIENT_SECRETS, coreKeyEnv, OIDC_ISSUER} from "./oidc-harness"

export {OIDC_ISSUER} from "./oidc-harness"

export const SUPABASE_PROJECT = "https://signin.supabase.co"
export const SUPABASE_ISSUER = `${SUPABASE_PROJECT}/auth/v1`
export const SUPABASE_JWKS = `${SUPABASE_ISSUER}/.well-known/jwks.json`
export const SUPABASE_SECRET = "signin-test-jwt-secret-of-sufficient-length"
export const ADMIN_ORIGIN = "https://admin.test"
export const PORTAL_ORIGIN = "https://portal.test"
export const ADMIN_EMAIL = "admin@mentra.glass"

export const ENTRA_TENANT = "contoso-directory"
export const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`
export const ENTRA_JWKS = `https://login.microsoftonline.com/${ENTRA_TENANT}/discovery/v2.0/keys`
export const CORE_API_CLIENT = "core-api-client"
export const CORE_API_SECRET = "core-api-browser-secret"

/** Core's signing keys for the sign-in suites: one pair per test process. */
export const SIGNIN_KEYS = coreKeyEnv()
const COOKIE_KEYS = "signin-cookie-key-0123456789abcdef0123456789"

export const HOSTED_ENV: Record<string, string | undefined> = {
  ...SIGNIN_KEYS,
  SUPABASE_URL: SUPABASE_PROJECT,
  SUPABASE_JWT_SECRET: SUPABASE_SECRET,
  SUPABASE_ANON_KEY: "sb_publishable_signin_test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_signin_test",
  CLOUD_CORE_SUPABASE_ISSUER: SUPABASE_ISSUER,
  CLOUD_CORE_SUPABASE_JWKS_URL: SUPABASE_JWKS,
  CLOUD_CORE_ADMIN_PORTAL_URL: ADMIN_ORIGIN,
  CLOUD_CORE_ENTERPRISE_PORTAL_URL: PORTAL_ORIGIN,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_OIDC_PROVIDERS: undefined,
  ENTRA_BROWSER_CLIENT_SECRET: undefined,
  CLOUD_CORE_ISSUER: "cloud-core",
  CLOUD_CORE_OIDC_ISSUER: OIDC_ISSUER,
  CLOUD_CORE_OIDC_COOKIE_KEYS: COOKIE_KEYS,
  CLOUD_CORE_OIDC_CLIENTS: JSON.stringify(CLIENTS),
  ...CLIENT_SECRETS,
}

/** A Private Cloud: Core's sign-in server and the admin portal share Core's one host, in front of the customer's Entra. */
export const PRIVATE_CLOUD_ENV: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.keys(HOSTED_ENV).map(key => [key, undefined])),
  ...SIGNIN_KEYS,
  CLOUD_CORE_ISSUER: ADMIN_ORIGIN,
  CLOUD_CORE_ADMIN_PORTAL_URL: ADMIN_ORIGIN,
  CLOUD_CORE_ADMIN_EMAILS: "it-admin@contoso.com",
  CLOUD_CORE_OIDC_ISSUER: ADMIN_ORIGIN,
  CLOUD_CORE_OIDC_COOKIE_KEYS: COOKIE_KEYS,
  CLOUD_CORE_OIDC_CLIENTS: JSON.stringify([
    {
      clientId: "admin-portal",
      kind: "admin_portal",
      secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
      redirectUris: [`${ADMIN_ORIGIN}/api/admin/auth/callback`],
    },
  ]),
  CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: CLIENT_SECRETS.CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET,
  ENTRA_BROWSER_CLIENT_SECRET: CORE_API_SECRET,
  CLOUD_CORE_OIDC_PROVIDERS: JSON.stringify([
    {
      id: "workforce",
      protocol: "oidc",
      providerKind: "microsoft-entra",
      tenantId: "contoso",
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      audience: CORE_API_CLIENT,
      subjectClaim: "oid",
      directoryTenantClaim: "tid",
      expectedDirectoryTenantId: ENTRA_TENANT,
      requiredScopes: ["mentra.session"],
      allowedClientIds: ["mobile-client"],
      verifiedEmailDomains: ["contoso.com"],
      browser: {
        clientId: CORE_API_CLIENT,
        clientSecretEnv: "ENTRA_BROWSER_CLIENT_SECRET",
        scopes: ["openid", "email", "profile"],
        emailClaim: "email",
        displayName: "Contoso",
      },
    },
  ]),
}

/** Entra's redirect back to Core's sign-in server on a Private Cloud. */
export const ENTRA_CALLBACK = `${ADMIN_ORIGIN}/interaction/callback/workforce`

/** Apply `env` (undefined deletes); returns a function that restores the previous values. */
export function applyEnv(env: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The full `Set-Cookie` line for `name`, if the response sets it. */
export function setCookieLine(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find(line => line.startsWith(`${name}=`))
}

/** The value a response sets for cookie `name` (empty string for a deletion), or null. */
export function cookieValue(response: Response, name: string): string | null {
  const line = setCookieLine(response, name)
  if (line === undefined) return null
  return decodeURIComponent(line.slice(name.length + 1).split(";")[0] ?? "")
}

export const TX_COOKIE = "__Host-mentra_client_tx"
export const ADMIN_COOKIE = "__Host-mentra_admin_session"
export const PORTAL_COOKIE = "__Host-mentra_portal_session"

export interface SignInResult {
  login: Response
  authorizeUrl: URL
  txCookie: string
  callbackUrl: URL
  done: Response
  sessionCookie: string | null
  /** The browser that signed in at Core's sign-in server (its provider session). */
  browser: Browser
}

/**
 * Run a portal sign-in through Core's sign-in server: the portal's login
 * redirect, the provider's sign-in step (the sign-in page's Supabase hand-off
 * on hosted Core, or Entra on a Private Cloud), the provider's redirect back,
 * and the portal's callback. A browser that already has a provider session
 * signs in without any sign-in step. The caller routes the issuer's origin to
 * `app` (`routeOriginsToApp`), as the sign-in site's relay does.
 */
export async function portalSignIn(
  app: Hono<any>,
  idp: FakeIdp,
  opts: {
    portal: "admin" | "portal"
    person: FakePerson
    returnTo?: string
    loginHeaders?: Record<string, string>
    /** Change the callback before Core sees it. */
    tamper?: (callback: URL) => URL
    omitTxCookie?: boolean
    browser?: Browser
    /** Supabase: when the page's Supabase session started (seconds). */
    sessionStartedAt?: number
  },
): Promise<SignInResult> {
  const origin = opts.portal === "admin" ? ADMIN_ORIGIN : PORTAL_ORIGIN
  const query = opts.returnTo === undefined ? "" : `?return_to=${encodeURIComponent(opts.returnTo)}`
  const login = await app.request(`${origin}/api/${opts.portal}/auth/login${query}`, {headers: opts.loginHeaders})
  expect(login.status).toBe(302)
  const authorizeUrl = new URL(login.headers.get("location")!)
  const txCookie = cookieValue(login, TX_COOKIE)!
  expect(txCookie).toBeTruthy()
  const browser = opts.browser ?? new Browser(app)
  const callbackPrefix = `${origin}/api/${opts.portal}/auth/callback`
  const atClient = (location: URL) => location.href.startsWith(callbackPrefix)
  let step = await browser.follow(authorizeUrl.href, location => atClient(location) || location.pathname.startsWith("/interaction/"))
  if ("stoppedAt" in step && !atClient(step.stoppedAt)) {
    const interaction = step.stoppedAt
    let continuation: string
    if (idp.kind === "supabase") {
      const uid = interaction.pathname.split("/")[2]!
      idp.registerUser(opts.person)
      const session = idp.startSession(opts.person.sub, null, opts.sessionStartedAt)
      const token = await idp.mint({
        sub: opts.person.sub,
        aud: "authenticated",
        role: "authenticated",
        email: opts.person.email ?? "",
        session_id: session.sessionId,
        amr: [{method: "password", timestamp: session.startedAt}],
        ...opts.person.claims,
      })
      const handoff = await browser.request(`${interaction.origin}/interaction/${uid}/supabase`, {
        method: "POST",
        headers: {"content-type": "application/json", origin: interaction.origin},
        body: JSON.stringify({access_token: token}),
      })
      const body = (await handoff.json()) as {redirectTo?: string}
      continuation = body.redirectTo ?? `${interaction.origin}/handoff-refused-${handoff.status}`
    } else {
      const toProvider = await browser.request(interaction)
      const location = toProvider.headers.get("location")
      if (!location) throw new Error(`no redirect to the identity provider: ${toProvider.status}`)
      const back = await browser.request(await idp.approve(location, opts.person))
      continuation = new URL(back.headers.get("location") ?? `/upstream-refused-${back.status}`, interaction.origin).href
    }
    step = await browser.follow(continuation, atClient)
  }
  let callbackUrl = "stoppedAt" in step ? step.stoppedAt : new URL(`${callbackPrefix}?sign-in-did-not-complete`)
  if (opts.tamper) callbackUrl = opts.tamper(callbackUrl)
  const done = await app.request(callbackUrl.href, {
    headers: opts.omitTxCookie ? {} : {cookie: `${TX_COOKIE}=${txCookie}`},
  })
  const sessionCookie = cookieValue(done, opts.portal === "admin" ? ADMIN_COOKIE : PORTAL_COOKIE)
  return {login, authorizeUrl, txCookie, callbackUrl, done, sessionCookie: sessionCookie || null, browser}
}

/**
 * A Core access token for a person, shaped exactly as Core's sign-in server
 * issues them (signed with Core's key under `kid` mentra-oidc-1, `typ`
 * `at+jwt`, this Core's issuer, Core's API audience, a first-party
 * `client_id`), with the person's Core user and sign-in identity recorded as a
 * sign-in would.
 */
export async function coreAccessToken(person: {
  sub: string
  email?: string | null
  emailVerified?: boolean
  tenantId?: string
  sourceId?: string
  clientId?: string
  iat?: number
  claims?: Record<string, unknown>
}): Promise<string> {
  const tenantId = person.tenantId ?? "mentra"
  const user = await findOrCreateUser({tenantId, tenantUserId: person.sub})
  await SigninIdentityModel.updateOne(
    {mentraUserId: user.mentraUserId},
    {
      $set: {
        tenantId,
        sourceId: person.sourceId ?? "mentra",
        subject: person.sub,
        email: person.email ?? null,
        emailVerified: person.emailVerified ?? true,
        name: null,
        signedInAt: new Date(),
      },
    },
    {upsert: true},
  )
  const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${process.env.MENTRA_JWT_PRIVATE_KEY}\n-----END PRIVATE KEY-----`, "EdDSA")
  const iat = person.iat ?? Math.floor(Date.now() / 1000)
  // `claims` override any standard claim (for example `aud`, to shape an ID token).
  return new jose.SignJWT({
    iss: process.env.CLOUD_CORE_OIDC_ISSUER ?? OIDC_ISSUER,
    aud: "urn:mentra:core",
    sub: user.mentraUserId,
    jti: randomUUID(),
    iat,
    exp: iat + 3600,
    client_id: person.clientId ?? "console",
    scope: "openid email profile",
    ...person.claims,
  })
    .setProtectedHeader({alg: "EdDSA", kid: "mentra-oidc-1", typ: "at+jwt"})
    .sign(key)
}
