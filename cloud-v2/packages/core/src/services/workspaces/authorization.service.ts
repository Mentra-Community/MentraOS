/**
 * @fileoverview What a principal may do.
 *
 * Who is calling is resolved in `signin/principal.service.ts`. Authorization has
 * two separate scopes:
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
  type OrganizationView,
  type WorkspaceCapability,
} from "@mentra/workspace-contract"
import {workspaceCreationPolicy} from "./organization"
import {getActiveMembership, getWorkspace, isWorkspaceRole} from "./workspace.service"

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

/** The organization as this caller sees it: its organization capabilities and whether it may create a workspace. */
export function organizationView(p: CorePrincipal): OrganizationView {
  const held = organizationCapabilities(p)
  return {
    capabilities: ORGANIZATION_CAPABILITIES.filter(capability => held.has(capability)),
    workspaceCreation: workspaceCreation(p),
  }
}

/** Whether `p` may create a workspace now, by the same rules `createWorkspace` applies. */
function workspaceCreation(p: CorePrincipal): OrganizationView["workspaceCreation"] {
  if (p.kind !== "user") return {allowed: false, reason: "not_a_person"}
  if (workspaceCreationPolicy() === "organization-admins" && !p.isOrganizationAdmin) {
    return {allowed: false, reason: "organization_admins_only"}
  }
  if (!p.emailVerified) return {allowed: false, reason: "email_unverified"}
  return {allowed: true, reason: null}
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
