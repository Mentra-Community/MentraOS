/**
 * @fileoverview Shared setup for Core's web sign-in suites: environment
 * fixtures for hosted Core (Supabase) and a Private Cloud (Entra), cookie
 * helpers, and a driver for a full portal sign-in through a fake provider.
 */

import {expect} from "bun:test"
import type {Hono} from "hono"

import type {FakeIdp, FakePerson} from "./fake-idp"

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

export const HOSTED_ENV: Record<string, string | undefined> = {
  SUPABASE_URL: SUPABASE_PROJECT,
  SUPABASE_JWT_SECRET: SUPABASE_SECRET,
  SUPABASE_ANON_KEY: "sb_publishable_signin_test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_signin_test",
  CLOUD_CORE_SUPABASE_ISSUER: SUPABASE_ISSUER,
  CLOUD_CORE_SUPABASE_JWKS_URL: SUPABASE_JWKS,
  CLOUD_CORE_WEB_CLIENT_IDS: "admin-client,portal-client,console-client",
  CLOUD_CORE_ADMIN_PORTAL_URL: ADMIN_ORIGIN,
  CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID: "admin-client",
  CLOUD_CORE_ADMIN_PORTAL_CLIENT_SECRET: "admin-secret",
  CLOUD_CORE_ENTERPRISE_PORTAL_URL: PORTAL_ORIGIN,
  CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID: "portal-client",
  CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_SECRET: "portal-secret",
  CLOUD_CORE_IDP_SIGNOUT_URL: "https://account.test/signout",
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_OIDC_PROVIDERS: undefined,
  ENTRA_BROWSER_CLIENT_SECRET: undefined,
}

export const PRIVATE_CLOUD_ENV: Record<string, string | undefined> = {
  ...Object.fromEntries(Object.keys(HOSTED_ENV).map(key => [key, undefined])),
  CLOUD_CORE_ADMIN_PORTAL_URL: ADMIN_ORIGIN,
  CLOUD_CORE_ADMIN_EMAILS: "it-admin@contoso.com",
  CLOUD_CORE_IDP_SIGNOUT_URL: `https://login.microsoftonline.com/${ENTRA_TENANT}/oauth2/v2.0/logout`,
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
}

/** Run a portal sign-in: login redirect, approval at the fake provider, callback. */
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
  },
): Promise<SignInResult> {
  const origin = opts.portal === "admin" ? ADMIN_ORIGIN : PORTAL_ORIGIN
  const query = opts.returnTo === undefined ? "" : `?return_to=${encodeURIComponent(opts.returnTo)}`
  const login = await app.request(`${origin}/api/${opts.portal}/auth/login${query}`, {headers: opts.loginHeaders})
  expect(login.status).toBe(302)
  const authorizeUrl = new URL(login.headers.get("location")!)
  const txCookie = cookieValue(login, TX_COOKIE)!
  expect(txCookie).toBeTruthy()
  let callbackUrl = await idp.approve(authorizeUrl, opts.person)
  if (opts.tamper) callbackUrl = opts.tamper(callbackUrl)
  const done = await app.request(callbackUrl.href, {
    headers: opts.omitTxCookie ? {} : {cookie: `${TX_COOKIE}=${txCookie}`},
  })
  const sessionCookie = cookieValue(done, opts.portal === "admin" ? ADMIN_COOKIE : PORTAL_COOKIE)
  return {login, authorizeUrl, txCookie, callbackUrl, done, sessionCookie: sessionCookie || null}
}
