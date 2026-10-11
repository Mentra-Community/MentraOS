/**
 * @fileoverview Principal-based request gates for Core's portal APIs.
 *
 * `principalAuth` requires a person or a Core credential and puts it on
 * `c.var.principal` (resolved once per request). The session cookie it reads
 * belongs to the route group: the admin portal's for `/api/admin`, the
 * enterprise portal's for `/api/portal`.
 *
 * Unsafe requests authenticated by a portal cookie (no bearer) must come from
 * the portal itself: `Origin` equal to the portal's configured origin, or
 * `Sec-Fetch-Site: same-origin` when `Origin` is absent. SameSite cookies
 * alone are not CSRF protection. Bearer requests are unaffected.
 *
 * Status mapping: no principal 401 `{error: "unauthorized"}`; the identity
 * provider could not be asked 503 `{error: "temporarily_unavailable"}`;
 * a cross-origin cookie request, a credential where a person is required, or a
 * missing organization capability 403 `{error: "forbidden"}`.
 */

import type {MiddlewareHandler} from "hono"
import {createMiddleware} from "hono/factory"

import type {PortalKind} from "../../services/signin/browser-session.service"
import {IdentityProviderUnavailableError} from "../../services/signin/idp-tokens"
import {isSameOrigin, portalClientIfConfigured} from "../../services/signin/portal-signin.service"
import {bearerToken, principalFromBearerOrSession, type CorePrincipal} from "../../services/signin/principal.service"
import type {AppContext, AppEnv} from "../../types/hono.types"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** The route group's portal: `/api/portal/*` is the enterprise portal, everything else the admin portal. */
function portalForPath(path: string): PortalKind {
  return path === "/api/portal" || path.startsWith("/api/portal/") ? "portal" : "admin"
}

type Resolved = {principal: CorePrincipal} | {response: Response}

async function requirePrincipal(c: AppContext, portal: PortalKind): Promise<Resolved> {
  const existing = c.get("principal")
  if (existing) return {principal: existing}
  const cookieAuthenticated = bearerToken(c.req.header("authorization")) === null
  if (cookieAuthenticated && !SAFE_METHODS.has(c.req.method)) {
    const pc = portalClientIfConfigured(portal)
    if (!pc || !isSameOrigin(c, pc.origin)) {
      return {response: c.json({error: "forbidden", error_description: "cross-origin request refused"}, 403)}
    }
  }
  let principal: CorePrincipal | null
  try {
    principal = await principalFromBearerOrSession(c, {sessionCookie: portal})
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) {
      return {response: c.json({error: "temporarily_unavailable", error_description: "identity provider unavailable"}, 503)}
    }
    throw err
  }
  if (!principal) return {response: c.json({error: "unauthorized", error_description: "sign-in required"}, 401)}
  c.set("principal", principal)
  return {principal}
}

/** Requires a person or a Core credential. `portal` defaults from the route group. */
export function principalAuth(portal?: PortalKind): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await requirePrincipal(c, portal ?? portalForPath(c.req.path))
    if ("response" in resolved) return resolved.response
    return next()
  })
}

/** Requires a signed-in person; a Core credential gets 403. */
export function requireUserPrincipal(portal?: PortalKind): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await requirePrincipal(c, portal ?? portalForPath(c.req.path))
    if ("response" in resolved) return resolved.response
    if (resolved.principal.kind !== "user") return c.json({error: "forbidden", error_description: "a signed-in person is required"}, 403)
    return next()
  })
}

/** Requires an Organization Admin: a verified allowlisted email, or an allowlisted admin key. */
export function requireOrganizationAdmin(portal?: PortalKind): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await requirePrincipal(c, portal ?? portalForPath(c.req.path))
    if ("response" in resolved) return resolved.response
    if (!resolved.principal.isOrganizationAdmin) return c.json({error: "forbidden", error_description: "admin access required"}, 403)
    return next()
  })
}

/** The person behind this request. Call only behind `requireUserPrincipal`. */
export function userPrincipal(c: AppContext): Extract<CorePrincipal, {kind: "user"}> {
  const principal = c.get("principal")
  if (principal?.kind !== "user") throw new Error("userPrincipal requires a user principal; mount requireUserPrincipal")
  return principal
}

/** A short label for audit fields: the person's email or Core user ID, or the key's label. Never a token. */
export function principalLabel(principal: CorePrincipal): string {
  if (principal.kind === "user") return principal.email ?? principal.mentraUserId
  return principal.label
}
