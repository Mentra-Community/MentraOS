/**
 * @fileoverview Principal-based request gates.
 *
 * `principalAuth` requires a signed-in person or a valid Core credential.
 * `requireOrganizationCapability` and `requireWorkspaceCapability` add the
 * authorization decision. The principal is resolved once per request and cached
 * on `c.var.principal`, so stacking the gates does not authenticate twice, and
 * each gate works on its own too.
 *
 * Status mapping:
 *  - no principal: 401 `{error: "unauthorized"}`;
 *  - a first sign-in the identity provider could not vouch for (it could not be
 *    asked about the profile): 503 `{error: "identity_unavailable"}`, retryable;
 *  - missing organization capability: 403 `{error: "forbidden"}`;
 *  - unknown or deleted workspace: 404 `{error: "workspace_not_found"}`;
 *  - any other workspace denial: 403 `{error: "forbidden", reason}`.
 */

import type {
  AuthorizeResponse,
  CorePrincipal,
  OrganizationCapability,
  WorkspaceCapability,
} from "@mentra/workspace-contract"
import type {MiddlewareHandler} from "hono"
import {createMiddleware} from "hono/factory"
import {
  authorize,
  organizationCapabilities,
  principalFromBearerOrSession,
} from "../../services/workspaces/authorization.service"
import {IdentityUnavailableError} from "../../services/workspaces/identity-link.service"
import type {AppContext, AppEnv} from "../../types/hono.types"

/** The request's principal, resolving it on first use. */
async function resolvePrincipal(c: AppContext): Promise<CorePrincipal | null> {
  const existing = c.get("principal")
  if (existing) return existing
  const principal = await principalFromBearerOrSession(c)
  if (principal) c.set("principal", principal)
  return principal
}

const unauthorized = (c: AppContext) => c.json({error: "unauthorized"}, 401)

/** The request's principal, or the response that refuses the request when it has none. */
async function requirePrincipal(c: AppContext): Promise<{principal: CorePrincipal} | {response: Response}> {
  let principal: CorePrincipal | null
  try {
    principal = await resolvePrincipal(c)
  } catch (err) {
    // Nothing was written, and signing in again once the identity provider answers works.
    if (err instanceof IdentityUnavailableError) return {response: c.json({error: "identity_unavailable"}, 503)}
    throw err
  }
  return principal ? {principal} : {response: unauthorized(c)}
}

/** Requires a principal (a signed-in person or a valid `msk_` / `mak_` credential). */
export const principalAuth: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const resolved = await requirePrincipal(c)
  if ("response" in resolved) return resolved.response
  return next()
})

/** Requires an organization capability: an Organization Admin, or an operator key that carries it. */
export function requireOrganizationCapability(capability: OrganizationCapability): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const resolved = await requirePrincipal(c)
    if ("response" in resolved) return resolved.response
    if (!organizationCapabilities(resolved.principal).has(capability)) return c.json({error: "forbidden"}, 403)
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
    const resolved = await requirePrincipal(c)
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
      return unauthorized(c)
    case "workspace_not_found":
    case "workspace_deleted":
      return c.json({error: "workspace_not_found"}, 404)
    default:
      return c.json({error: "forbidden", reason: decision.reason}, 403)
  }
}

/** A short label for audit and actor fields: the person's email, or `credential:<id>`. Never a token or key name. */
export function principalLabel(p: CorePrincipal): string {
  if (p.kind === "user") return p.email || `user:${p.mentraUserId}`
  return `credential:${p.credentialId}`
}
