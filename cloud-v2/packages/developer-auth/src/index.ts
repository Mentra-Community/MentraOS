import {WorkOS} from "@workos-inc/node"
import {getCookie, setCookie, deleteCookie} from "hono/cookie"
import {createRemoteJWKSet, jwtVerify} from "jose"
import type {Context} from "hono"

export type DeveloperAuthResult =
  | {
      authenticated: true
      user: {id: string; email: string; firstName?: string | null; lastName?: string | null}
      organizationId?: string | null
    }
  | {authenticated: false; reason: string}

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
  if (bearer) return authenticateBearer(bearer, options)
  const cookieName = options.sessionCookieName ?? "mentra_console_session"
  const sessionData = getCookie(c, cookieName)
  if (!sessionData) return {authenticated: false, reason: "no_session_cookie_provided"}
  const workos = new WorkOS(options.apiKey)
  const session = workos.userManagement.loadSealedSession({sessionData, cookiePassword: options.cookiePassword})
  const result = await session.authenticate()
  let authenticated: {
    user: {id: string; email: string; firstName?: string | null; lastName?: string | null}
    organizationId?: string | null
  } | null = result.authenticated ? result : null
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
    authenticated = refreshed
  }
  if (!authenticated) return {authenticated: false, reason: result.authenticated ? "unknown" : result.reason}
  return {
    authenticated: true,
    user: {
      id: authenticated.user.id,
      email: authenticated.user.email,
      firstName: authenticated.user.firstName,
      lastName: authenticated.user.lastName,
    },
    organizationId: authenticated.organizationId ?? null,
  }
}

async function authenticateBearer(token: string, options: DeveloperAuthOptions): Promise<DeveloperAuthResult> {
  try {
    const verified = await jwtVerify(
      token,
      createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${options.clientId}`)),
    )
    const id = typeof verified.payload.sub === "string" ? verified.payload.sub : ""
    if (!id) return {authenticated: false, reason: "missing_sub"}
    let email = typeof verified.payload.email === "string" ? verified.payload.email : ""
    let firstName = typeof verified.payload.first_name === "string" ? verified.payload.first_name : null
    let lastName = typeof verified.payload.last_name === "string" ? verified.payload.last_name : null
    try {
      const user = await new WorkOS(options.apiKey).userManagement.getUser(id)
      email = user.email || email
      firstName = user.firstName ?? firstName
      lastName = user.lastName ?? lastName
    } catch {
      // Verified claims remain sufficient if profile enrichment is unavailable.
    }
    return {
      authenticated: true,
      user: {id, email: email || "unknown", firstName, lastName},
      organizationId: typeof verified.payload.org_id === "string" ? verified.payload.org_id : null,
    }
  } catch {
    return {authenticated: false, reason: "invalid_bearer_token"}
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7).trim() || null
}
