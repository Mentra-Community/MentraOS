/**
 * @fileoverview Principal-based request gates for Core's portal and workspace APIs.
 *
 * `principalAuth` requires a person or a Core credential and puts it on
 * `c.var.principal` (resolved once per request, so stacking gates does not
 * authenticate twice). `requireUserPrincipal`, `requireOrganizationCapability`
 * and `requireWorkspaceCapability` add the authorization decision on top.
 *
 * The session cookie a request may use belongs to its route group: the admin
 * portal's for `/api/admin`, the workspace portal's for `/api/portal`, and none
 * for `/api/workspaces` and `/api/organization`, which take bearers only (Core
 * keys and Core access tokens). The same workspace handlers are
 * mounted under each group, so each portal reaches them with its own session.
 *
 * Unsafe requests authenticated by a portal cookie (no bearer) must come from
 * the portal itself: `Origin` equal to the portal's configured origin, or
 * `Sec-Fetch-Site: same-origin` when `Origin` is absent. SameSite cookies
 * alone are not CSRF protection. Bearer requests are unaffected.
 *
 * Status mapping:
 *  - no principal: 401 `{error: "unauthorized"}`;
 *  - a cross-origin cookie request, a credential where a person is required, or a
 *    missing organization capability: 403 `{error: "forbidden"}`;
 *  - an unknown or deleted workspace: 404 `{error: "workspace_not_found"}`;
 *  - any other workspace denial: 403 `{error: "forbidden", reason}`.
 */

import type {AuthorizeResponse, OrganizationCapability, WorkspaceCapability} from "@mentra/workspace-contract"
import type {MiddlewareHandler} from "hono"
import {createMiddleware} from "hono/factory"

import type {PortalKind} from "../../services/signin/browser-session.service"
import {isSameOrigin, portalSite} from "../../services/signin/portal-signin.service"
import {
  bearerToken,
  principalFromBearerOrSession,
  type CorePrincipal,
  type UserPrincipal,
} from "../../services/signin/principal.service"
import {authorize, organizationCapabilities} from "../../services/workspaces/authorization.service"
import type {Actor} from "../../services/workspaces/workspace.service"
import type {AppContext, AppEnv} from "../../types/hono.types"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The route group's portal session: `/api/portal/*` the workspace portal's, `/api/admin/*` the admin
 * portal's. Any other route group (`/api/workspaces`, `/api/organization`) reads no cookie.
 */
function portalForPath(path: string): PortalKind | null {
  if (path === "/api/portal" || path.startsWith("/api/portal/")) return "portal"
  if (path === "/api/admin" || path.startsWith("/api/admin/")) return "admin"
  return null
}

type Resolved = {principal: CorePrincipal} | {response: Response}

async function requirePrincipal(c: AppContext, portal: PortalKind | null): Promise<Resolved> {
  const existing = c.get("principal")
  if (existing) return {principal: existing}
  const cookieAuthenticated = bearerToken(c.req.header("authorization")) === null
  if (portal && cookieAuthenticated && !SAFE_METHODS.has(c.req.method)) {
    const pc = portalSite(portal)
    if (!pc || !isSameOrigin(c, pc.origin)) {
      return {response: c.json({error: "forbidden", error_description: "cross-origin request refused"}, 403)}
    }
  }
  const principal = await principalFromBearerOrSession(c, {sessionCookie: portal})
  if (!principal) return {response: c.json({error: "unauthorized", error_description: "sign-in required"}, 401)}
  c.set("principal", principal)
  return {principal}
}

const resolveFor = (c: AppContext, portal: PortalKind | null | undefined) =>
  requirePrincipal(c, portal === undefined ? portalForPath(c.req.path) : portal)

/** Requires a person or a Core credential. `portal` defaults from the route group. */
export function principalAuth(portal?: PortalKind | null): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await resolveFor(c, portal)
    if ("response" in resolved) return resolved.response
    return next()
  })
}

/** Requires a signed-in person; a Core credential gets 403. Workspace administration is done by people. */
export function requireUserPrincipal(portal?: PortalKind | null): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await resolveFor(c, portal)
    if ("response" in resolved) return resolved.response
    if (resolved.principal.kind !== "user") {
      return c.json({error: "forbidden", error_description: "a signed-in person is required"}, 403)
    }
    return next()
  })
}

/** Requires an organization capability: an Organization Admin, or an operator key that carries it. */
export function requireOrganizationCapability(capability: OrganizationCapability): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await resolveFor(c, undefined)
    if ("response" in resolved) return resolved.response
    if (!organizationCapabilities(resolved.principal).has(capability)) {
      return c.json({error: "forbidden", error_description: `${capability} is required`}, 403)
    }
    return next()
  })
}

/**
 * Requires an Organization Admin who is a person (a verified allowlisted email). For the administration
 * of Core's built-in Store, which has no organization capability of its own; keys are refused.
 */
export function requireOrganizationAdminPerson(): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await resolveFor(c, undefined)
    if ("response" in resolved) return resolved.response
    if (resolved.principal.kind !== "user" || !resolved.principal.isOrganizationAdmin) {
      return c.json({error: "forbidden", error_description: "an Organization Admin is required"}, 403)
    }
    return next()
  })
}

/**
 * Requires `capability` in the workspace named by the route parameter `param`.
 * On success the decision is on `c.var.workspaceAuthorization`.
 *
 * It does not evaluate package scope: a package-restricted `msk_` key passes this gate for any package
 * of its workspace, so a route that acts on one package must also call
 * `authorize(principal, {workspaceId, capability, packageName})`.
 */
export function requireWorkspaceCapability(
  capability: WorkspaceCapability,
  param = "workspaceId",
): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await resolveFor(c, undefined)
    if ("response" in resolved) return resolved.response
    // A route without the parameter must fail closed: authorizing "no workspace" would allow everyone.
    const workspaceId = c.req.param(param)
    if (!workspaceId) return c.json({error: "workspace_not_found"}, 404)
    const decision = await authorize(resolved.principal, {workspaceId, capability})
    if (!decision.allowed) return denied(c, decision)
    c.set("workspaceAuthorization", decision)
    return next()
  })
}

function denied(c: AppContext, decision: AuthorizeResponse) {
  switch (decision.reason) {
    case "unauthenticated":
    case "credential_invalid":
      return c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
    case "workspace_not_found":
    case "workspace_deleted":
      return c.json({error: "workspace_not_found", error_description: "workspace not found"}, 404)
    default:
      return c.json({error: "forbidden", error_description: "not allowed in this workspace", reason: decision.reason}, 403)
  }
}

/** The person behind this request. Call only behind `requireUserPrincipal`. */
export function userPrincipal(c: AppContext): UserPrincipal {
  const principal = c.get("principal")
  if (principal?.kind !== "user") throw new Error("userPrincipal requires a user principal; mount requireUserPrincipal")
  return principal
}

/** The actor the workspace services act for: the signed-in person behind this request. */
export function userActor(c: AppContext): Actor & {kind: "user"} {
  const principal = userPrincipal(c)
  return {
    kind: "user",
    mentraUserId: principal.mentraUserId,
    email: principal.email,
    emailVerified: principal.emailVerified,
    isOrganizationAdmin: principal.isOrganizationAdmin,
  }
}

/** A short label for audit fields: the person's email or Core user ID, or `credential:<id>`. Never a token. */
export function principalLabel(principal: CorePrincipal): string {
  if (principal.kind === "user") return principal.email ?? principal.mentraUserId
  return `credential:${principal.credentialId}`
}
