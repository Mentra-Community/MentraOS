import {WorkOS} from "@workos-inc/node"
import {getCookie, setCookie, deleteCookie} from "hono/cookie"
import {createRemoteJWKSet, jwtVerify} from "jose"
import type {Context} from "hono"

export type DeveloperAuthUser = {
  id: string
  email: string
  /** Whether WorkOS has verified `email`. Authorization must not trust an unverified address. */
  emailVerified: boolean
  firstName?: string | null
  lastName?: string | null
}

export type DeveloperAuthResult =
  | {
      authenticated: true
      user: DeveloperAuthUser
      organizationId?: string | null
      /** The WorkOS access token behind this request: the bearer value, or the sealed session's access token. */
      accessToken: string
      /**
       * Set only on the bearer path, when the profile lookup failed. `user.emailVerified` is then `false`
       * because the answer is unknown, not because WorkOS said the email is unverified; a caller that
       * makes a lasting decision from it (linking an account) must not treat the two alike.
       */
      profileUnavailable?: boolean
    }
  | {authenticated: false; reason: string}

/**
 * The `user.email` of a bearer-authenticated user when neither the token nor the
 * profile has an email. It is a placeholder, not an address: callers that store
 * or match on emails must treat it as no email.
 */
export const UNKNOWN_EMAIL = "unknown"

export interface DeveloperAuthOptions {
  apiKey: string
  clientId: string
  cookiePassword: string
  sessionCookieName?: string
  secureCookies?: boolean
}

/** Shared WorkOS identity adapter for Console, Store, Core Portal, and CLI-backed APIs. */
export async function authenticateWorkosRequest(
  c: Context<any>,
  options: DeveloperAuthOptions,
): Promise<DeveloperAuthResult> {
  const bearer = bearerToken(c.req.header("authorization"))
  if (bearer) return authenticateWorkosAccessToken(bearer, options)
  const cookieName = options.sessionCookieName ?? "mentra_console_session"
  const sessionData = getCookie(c, cookieName)
  if (!sessionData) return {authenticated: false, reason: "no_session_cookie_provided"}
  const workos = new WorkOS(options.apiKey, {clientId: options.clientId})
  const session = workos.userManagement.loadSealedSession({sessionData, cookiePassword: options.cookiePassword})
  const result = await session.authenticate()
  let authenticated: {user: DeveloperAuthUser; organizationId?: string | null; accessToken: string} | null =
    result.authenticated
      ? {user: result.user, organizationId: result.organizationId, accessToken: result.accessToken}
      : null
  if (!result.authenticated && result.reason === "invalid_jwt") {
    const refreshed = await session.refresh()
    if (!refreshed.authenticated) {
      deleteCookie(c, cookieName, {path: "/"})
      return {authenticated: false, reason: refreshed.reason}
    }
    if (refreshed.sealedSession)
      setCookie(c, cookieName, refreshed.sealedSession, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: options.secureCookies ?? true,
        maxAge: 30 * 24 * 60 * 60,
      })
    // The refresh response carries the new access token (and the fresh user) under `session`.
    const refreshedSession = refreshed.session
    if (!refreshedSession) return {authenticated: false, reason: "missing_access_token"}
    authenticated = {
      user: refreshedSession.user,
      organizationId: refreshed.organizationId,
      accessToken: refreshedSession.accessToken,
    }
  }
  if (!authenticated) return {authenticated: false, reason: result.authenticated ? "unknown" : result.reason}
  return {
    authenticated: true,
    user: {
      id: authenticated.user.id,
      email: authenticated.user.email,
      emailVerified: authenticated.user.emailVerified === true,
      firstName: authenticated.user.firstName,
      lastName: authenticated.user.lastName,
    },
    organizationId: authenticated.organizationId ?? null,
    accessToken: authenticated.accessToken,
  }
}

/**
 * One remote key set per WorkOS client id. A remote key set caches the keys it
 * fetches (and rate-limits refetching on an unknown `kid`), so building one per
 * call would download the JWKS on every request.
 */
const jwksByClientId = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function jwksFor(clientId: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByClientId.get(clientId)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`))
    jwksByClientId.set(clientId, jwks)
  }
  return jwks
}

/**
 * Authenticate a bare WorkOS access token, for callers that hold a token but no
 * browser request (the internal service API). This is the same verification as
 * the `Authorization: Bearer` path of {@link authenticateWorkosRequest}: signature
 * against the client's JWKS, then a profile lookup for the verified-email flag.
 */
export async function authenticateWorkosAccessToken(
  token: string,
  options: DeveloperAuthOptions,
): Promise<DeveloperAuthResult> {
  try {
    const verified = await jwtVerify(token, jwksFor(options.clientId))
    const id = typeof verified.payload.sub === "string" ? verified.payload.sub : ""
    if (!id) return {authenticated: false, reason: "missing_sub"}
    let email = typeof verified.payload.email === "string" ? verified.payload.email : ""
    let firstName = typeof verified.payload.first_name === "string" ? verified.payload.first_name : null
    let lastName = typeof verified.payload.last_name === "string" ? verified.payload.last_name : null
    // Access-token claims do not say whether the email is verified, so only the profile lookup can.
    let emailVerified = false
    let profileUnavailable = false
    try {
      const user = await new WorkOS(options.apiKey, {clientId: options.clientId}).userManagement.getUser(id)
      email = user.email || email
      emailVerified = Boolean(user.email) && user.emailVerified === true
      firstName = user.firstName ?? firstName
      lastName = user.lastName ?? lastName
    } catch {
      // Verified claims remain sufficient to authenticate if profile enrichment is
      // unavailable, but the email then stays unverified, and the result says that
      // is because the lookup failed.
      profileUnavailable = true
    }
    return {
      authenticated: true,
      user: {id, email: email || UNKNOWN_EMAIL, emailVerified, firstName, lastName},
      organizationId: typeof verified.payload.org_id === "string" ? verified.payload.org_id : null,
      accessToken: token,
      ...(profileUnavailable ? {profileUnavailable: true} : {}),
    }
  } catch {
    return {authenticated: false, reason: "invalid_bearer_token"}
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7).trim() || null
}
