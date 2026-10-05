/** Workspace roles, capabilities and the role-change rules shared by Core, the Store and the CLI. */

export const WORKSPACE_ROLES = ["member", "developer", "admin", "owner"] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const WORKSPACE_CAPABILITIES = [
  "workspace.read",
  "miniapps.access",
  "miniapps.publish",
  "miniapps.credentials.create",
  "workspace.credentials.revoke",
  "workspace.members.read",
  "workspace.members.manage",
  "workspace.settings.manage",
  "workspace.audit.read",
  "workspace.roles.managePrivileged",
  "workspace.delete",
  "fleet.read",
  "fleet.devices.manage",
  "miniapps.assign",
] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

export const ORGANIZATION_CAPABILITIES = [
  "organization.workspaces.administer",
  "organization.credentials.manage",
  "organization.incidents.read",
  "organization.supportProfiles.read",
  "organization.testing.read",
  "organization.testing.manage",
] as const
export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number]

/** Scopes an operator key may carry; never workspace administration. */
export const OPERATOR_KEY_SCOPES: readonly OrganizationCapability[] = [
  "organization.incidents.read",
  "organization.supportProfiles.read",
  "organization.testing.read",
  "organization.testing.manage",
]

/** Capabilities each role adds on top of the role below it. */
const ROLE_ADDITIONS: Record<WorkspaceRole, readonly WorkspaceCapability[]> = {
  member: ["workspace.read", "miniapps.access"],
  developer: ["miniapps.publish", "miniapps.credentials.create"],
  admin: [
    "workspace.members.read",
    "workspace.members.manage",
    "workspace.settings.manage",
    "workspace.audit.read",
    "workspace.credentials.revoke",
    "fleet.read",
    "fleet.devices.manage",
    "miniapps.assign",
  ],
  owner: ["workspace.roles.managePrivileged", "workspace.delete"],
}

const CAPABILITIES_BY_ROLE = (() => {
  const result = {} as Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>>
  const accumulated = new Set<WorkspaceCapability>()
  for (const role of WORKSPACE_ROLES) {
    for (const capability of ROLE_ADDITIONS[role]) accumulated.add(capability)
    result[role] = new Set(accumulated)
  }
  return result
})()

export function capabilitiesForRole(role: WorkspaceRole): ReadonlySet<WorkspaceCapability> {
  return CAPABILITIES_BY_ROLE[role]
}

export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return WORKSPACE_ROLES.indexOf(role) >= WORKSPACE_ROLES.indexOf(min)
}

const isPrivileged = (role: WorkspaceRole | null) => role === "admin" || role === "owner"

/**
 * Whether `actor` may move a member from `from` to `to` (`null` is "not a member", so invite is
 * `null → role` and remove is `role → null`). Owner-only when either side of the transition is
 * admin or owner; otherwise an admin is enough.
 */
export function canChangeRole(actor: WorkspaceRole, from: WorkspaceRole | null, to: WorkspaceRole | null): boolean {
  if (isPrivileged(from) || isPrivileged(to)) return actor === "owner"
  return roleAtLeast(actor, "admin")
}
