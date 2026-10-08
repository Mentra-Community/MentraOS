/**
 * @fileoverview Who is calling, and what they may do.
 *
 * Resolution turns a request's credentials into one `CorePrincipal`:
 *  - a bearer that starts `msk_` / `mak_` is a Core credential and is validated
 *    as one (`validateCredentialToken`, which decides on every call who the key
 *    still acts for). It never falls through to WorkOS, and a credential that
 *    does not validate is no principal at all;
 *  - anything else is a WorkOS identity (access token or session cookie). The
 *    WorkOS user is linked to a Mentra user (claiming any migrated memberships)
 *    and is an Organization Admin only when the identity provider verified an
 *    email that is on the allowlist. When WorkOS could not be asked about the
 *    profile, a first sign-in is refused (`IdentityUnavailableError`) rather than
 *    linked on a guess; an existing link signs in, with the email unverified.
 *
 * Authorization has two separate scopes:
 *  - organization capabilities (`organizationCapabilities`): what the caller may
 *    do to the deployment itself. Organization Admins have all of them, an
 *    operator key has the operator scopes it was created with and a workspace
 *    credential has none;
 *  - workspace capabilities (`authorize`): what the caller may do inside one
 *    workspace. A member has their role's capabilities, an Organization Admin
 *    acts as owner anywhere (as `workspace.service` does for every mutation), a
 *    workspace credential has its scopes in its own workspace only, and an
 *    operator key never has workspace capabilities.
 *
 * `authorize` answers with a full `AuthorizeResponse` and never throws for a
 * denial: the reason says why. Only a database failure throws.
 */

import {UNKNOWN_EMAIL, type DeveloperAuthResult} from "@mentra/developer-auth"
import {
  capabilitiesForRole,
  OPERATOR_KEY_SCOPES,
  ORGANIZATION_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  type AuthorizeResponse,
  type CorePrincipal,
  type DenyReason,
  type MembershipSummary,
  type OrganizationCapability,
  type WorkspaceCapability,
} from "@mentra/workspace-contract"
import type {AppContext} from "../../types/hono.types"
import {authenticateDeveloperAccessToken, authenticateDeveloperRequest} from "../developer-auth.service"
import {isCredentialToken, validateCredentialToken} from "./credential.service"
import {resolveWorkosUser} from "./identity-link.service"
import {isOrganizationAdminEmail} from "./organization"
import {getActiveMembership, getWorkspace, isWorkspaceRole} from "./workspace.service"

// --- Principals ------------------------------------------------------------

/**
 * The principal behind a request, or null: a Core credential in the bearer
 * header, otherwise the WorkOS bearer or session cookie.
 */
export async function principalFromBearerOrSession(c: AppContext): Promise<CorePrincipal | null> {
  const token = bearerToken(c.req.header("authorization"))
  if (token && isCredentialToken(token)) return validateCredentialToken(token)
  return userPrincipal(await authenticateDeveloperRequest(c))
}

/** The principal a raw bearer token stands for, for callers with no browser request (the service API). */
export async function principalFromToken(token: string): Promise<CorePrincipal | null> {
  const trimmed = typeof token === "string" ? token.trim() : ""
  if (!trimmed) return null
  if (isCredentialToken(trimmed)) return validateCredentialToken(trimmed)
  return userPrincipal(await authenticateDeveloperAccessToken(trimmed))
}

async function userPrincipal(auth: DeveloperAuthResult): Promise<CorePrincipal | null> {
  if (!auth.authenticated) return null
  const {user} = auth
  // A token with no email comes back with a placeholder; it is not an address and must never be stored.
  const email = user.email && user.email !== UNKNOWN_EMAIL ? user.email : null
  const emailVerified = email !== null && user.emailVerified
  const name =
    [user.firstName, user.lastName]
      .map(part => part?.trim())
      .filter(Boolean)
      .join(" ") || null
  const {mentraUserId} = await resolveWorkosUser({
    workosUserId: user.id,
    email,
    // A failed profile lookup says nothing about the email, which is different from "unverified".
    emailVerified: auth.profileUnavailable ? null : emailVerified,
    name,
  })
  return {
    kind: "user",
    mentraUserId,
    email,
    emailVerified,
    name,
    workosUserId: user.id,
    isOrganizationAdmin: isOrganizationAdminEmail(email, emailVerified),
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7).trim() || null
}

// --- Organization capabilities ---------------------------------------------

/**
 * What the principal may do to the organization itself. Organization Admins have
 * every organization capability. An operator key has only the operator scopes
 * (`OPERATOR_KEY_SCOPES`) among its stored scopes: anything else a row carries is
 * ignored, so a key can never hold workspace administration. A workspace
 * credential has none.
 */
export function organizationCapabilities(p: CorePrincipal): Set<OrganizationCapability> {
  if (p.kind === "user") return new Set(p.isOrganizationAdmin ? ORGANIZATION_CAPABILITIES : [])
  if (p.credentialKind !== "organization") return new Set()
  const held = p.scopes
  return new Set(OPERATOR_KEY_SCOPES.filter(scope => held.includes(scope)))
}

// --- Workspace authorization -----------------------------------------------

/**
 * Decide what `p` may do in a workspace.
 *
 * Without a `workspaceId` there is nothing workspace-scoped to grant: any
 * principal is allowed and has no capabilities, and asking for a `capability`
 * is a denial. With one, the workspace must exist and be active, then the
 * principal's standing decides (see the file header), then `packageName` (a
 * workspace credential restricted to certain packages) and `capability`.
 *
 * A `capability` is asked for whenever it is present, whatever its value: an
 * empty or unknown string is never "no capability" and is never granted
 * (`capability_missing`). The service API refuses a blank one as a malformed
 * request before it gets here.
 *
 * A principal with no standing in the workspace (`not_a_member`,
 * `package_out_of_scope`) gets no workspace details back.
 */
export async function authorize(
  p: CorePrincipal | null,
  req: {workspaceId?: string; capability?: WorkspaceCapability; packageName?: string},
): Promise<AuthorizeResponse> {
  if (!p) return {allowed: false, reason: "unauthenticated", principal: null, capabilities: []}
  const deny = (reason: DenyReason, extra: Partial<AuthorizeResponse> = {}): AuthorizeResponse => ({
    allowed: false,
    reason,
    principal: p,
    capabilities: [],
    ...extra,
  })

  const {workspaceId, capability, packageName} = req
  const capabilityAsked = capability !== undefined && capability !== null
  if (workspaceId === undefined || workspaceId === null) {
    if (capabilityAsked) return deny("capability_missing")
    return {allowed: true, principal: p, capabilities: []}
  }
  // The id goes into a database filter, so anything but a non-empty string is not a workspace.
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return deny("workspace_not_found", {workspace: null})

  const workspace = await getWorkspace(workspaceId)
  if (!workspace) return deny("workspace_not_found", {workspace: null})
  if (workspace.status !== "active") return deny("workspace_deleted", {workspace})

  let granted: ReadonlySet<WorkspaceCapability>
  let membership: MembershipSummary | null | undefined
  if (p.kind === "user") {
    const row = await getActiveMembership(workspaceId, p.mentraUserId)
    const role = row && isWorkspaceRole(row.role) ? row.role : null
    membership = row && role ? {membershipId: row.membershipId, role} : null
    if (p.isOrganizationAdmin) granted = capabilitiesForRole("owner")
    else if (role) granted = capabilitiesForRole(role)
    else return deny("not_a_member")
  } else if (p.credentialKind === "workspace" && p.workspaceId === workspaceId) {
    if (packageName !== undefined && packageName !== null && p.packageNames.length > 0) {
      if (!p.packageNames.includes(packageName)) return deny("package_out_of_scope")
    }
    // Scopes are already what the key may do right now (credential.service).
    granted = new Set(p.scopes.filter(isWorkspaceCapability))
  } else {
    // An operator key, or a workspace credential presented for a different workspace.
    return deny("not_a_member")
  }

  const capabilities = [...granted]
  if (capabilityAsked && !(isWorkspaceCapability(capability) && granted.has(capability))) {
    return deny("capability_missing", {workspace, membership, capabilities})
  }
  return {allowed: true, principal: p, workspace, membership, capabilities}
}

function isWorkspaceCapability(value: string): value is WorkspaceCapability {
  return (WORKSPACE_CAPABILITIES as readonly string[]).includes(value)
}
