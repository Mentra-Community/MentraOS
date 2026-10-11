/** What the viewer may do, worked out from the workspace detail the API sent them. */

import {
  canChangeRole,
  capabilitiesForRole,
  WORKSPACE_ROLES,
  type WorkspaceCapability,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@mentra/workspace-contract";

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  member: "Member",
  developer: "Developer",
  admin: "Admin",
  owner: "Owner",
};

/** Whether the workspace detail grants `capability`. Undefined (not loaded yet) grants nothing. */
export function can(detail: Pick<WorkspaceDetail, "capabilities"> | undefined, capability: WorkspaceCapability): boolean {
  return detail?.capabilities.includes(capability) ?? false;
}

/**
 * The highest role whose capabilities the viewer holds in full. This reads the capabilities rather than
 * the membership because that is how the server decides: an organization admin acts as an owner whether
 * they have no membership or a lower one.
 */
export function effectiveRole(detail: Pick<WorkspaceDetail, "capabilities">): WorkspaceRole | null {
  const held = new Set<WorkspaceCapability>(detail.capabilities);
  for (const role of [...WORKSPACE_ROLES].reverse()) {
    if ([...capabilitiesForRole(role)].every((capability) => held.has(capability))) return role;
  }
  return null;
}

/** The roles `viewer` may move someone from `from` (null: not yet a member) to, other than `from` itself. */
export function assignableRoles(viewer: WorkspaceRole | null, from: WorkspaceRole | null): WorkspaceRole[] {
  if (!viewer) return [];
  return WORKSPACE_ROLES.filter((to) => to !== from && canChangeRole(viewer, from, to));
}

/** The options of a role selector for a member now holding `from`: that role and what may replace it, or none. */
export function roleOptions(viewer: WorkspaceRole | null, from: WorkspaceRole): WorkspaceRole[] {
  const assignable = assignableRoles(viewer, from);
  if (assignable.length === 0) return [];
  return WORKSPACE_ROLES.filter((role) => role === from || assignable.includes(role));
}

/** Whether `viewer` may remove a member holding `from`. */
export function canRemoveRole(viewer: WorkspaceRole | null, from: WorkspaceRole): boolean {
  return viewer !== null && canChangeRole(viewer, from, null);
}

/**
 * Whether the viewer can create a credential here. Core ties a credential to its creator's membership and
 * refuses one whose creator is not a member whose own role can publish, so an organization admin acting
 * from outside the workspace (or from a lower role) can list and revoke credentials but not create them.
 */
export function canCreateCredentials(detail: Pick<WorkspaceDetail, "capabilities" | "membership"> | undefined): boolean {
  if (!detail?.membership || !can(detail, "miniapps.credentials.create")) return false;
  const held = capabilitiesForRole(detail.membership.role);
  return held.has("miniapps.credentials.create") && held.has("miniapps.publish");
}
