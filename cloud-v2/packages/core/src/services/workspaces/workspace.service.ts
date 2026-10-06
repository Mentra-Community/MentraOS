/**
 * @fileoverview Workspace lifecycle, memberships and role transitions.
 *
 * A workspace is a group of people with permissions inside this organization.
 * Every mutation here runs in one transaction and follows the same shape:
 *
 *  1. load the workspace (missing: `not_found`; deleted: `workspace_deleted`);
 *  2. compare `authorizationRevision` with the caller's `expectedRevision`
 *     (mismatch: `membership_changed`);
 *  3. resolve the actor's role (Organization Admins and the system act as
 *     `owner`; service actors have none);
 *  4. check the role-transition rules (`forbidden`) and the last-owner guard
 *     (`last_owner`);
 *  5. write the change, bump `authorizationRevision` and record the audit event.
 *
 * Concurrency: every mutation writes the workspace document (the revision
 * bump), so two overlapping mutations of one workspace conflict on it. The
 * loser's transaction is retried by `withTransaction` and re-validates against
 * the winner's result, which is how two owners demoting each other, or leaving,
 * at the same time end with exactly one owner.
 *
 * Memberships are never deleted: ending one keeps the row as history, and a
 * later re-join is a new row with a new `membershipId`.
 */

import {createLogger} from "@mentra/cloud-shared"
import {
  canChangeRole,
  capabilitiesForRole,
  roleAtLeast,
  WORKSPACE_ROLES,
  type PrincipalResponse,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {ulid} from "ulid"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel} from "../../models/access-credential.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel, type WorkspaceMembershipRow} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {clampPageSize, recordWorkspaceEvent, type WorkspaceAuditEventInput} from "./audit.service"
import {organizationId} from "./organization"
import {fail, WorkspaceError, type WorkspaceErrorCode} from "./workspace-error"

const logger = createLogger("core").child({service: "workspace.service"})

const NAME_MAX_LENGTH = 80

/**
 * Who is acting. For a user, `emailVerified` says whether the identity provider
 * verified `email`; anything that matches on the address (accepting an
 * invitation) requires it. `name` is display-only.
 */
export type Actor =
  | {
      kind: "user"
      mentraUserId: string
      email: string | null
      emailVerified: boolean
      name?: string | null
      isOrganizationAdmin: boolean
    }
  | {kind: "system"}
  | {kind: "service"; service: string; email: string | null}

export type MembershipRow = WorkspaceMembershipRow

export {WorkspaceError, type WorkspaceErrorCode}

// --- Reads -----------------------------------------------------------------

/** The workspace in any status (a deleted one reports `status: "deleted"`), or null. */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceSummary | null> {
  const row = await WorkspaceModel.findOne({workspaceId}).lean()
  return row ? toSummary(row) : null
}

/**
 * The workspaces a person belongs to, oldest first. Only claimed memberships
 * count (`mentraUserId` set): a migrated row still waiting for its first
 * sign-in belongs to nobody yet. Deleted workspaces are left out.
 */
export async function listWorkspacesForUser(mentraUserId: string): Promise<PrincipalResponse["workspaces"]> {
  // A missing id must not become a `null` filter, which would match every unclaimed row.
  if (!isId(mentraUserId)) return []
  const memberships = await WorkspaceMembershipModel.find({mentraUserId, status: "active"}).lean()
  if (memberships.length === 0) return []
  const byWorkspace = new Map(memberships.map(row => [row.workspaceId, row]))
  const workspaces = await WorkspaceModel.find({workspaceId: {$in: [...byWorkspace.keys()]}, status: "active"})
    .sort({_id: 1})
    .lean()
  return workspaces.map(workspace => {
    const membership = byWorkspace.get(workspace.workspaceId)!
    const role = membership.role as WorkspaceRole
    return {
      ...toSummary(workspace),
      membership: {membershipId: membership.membershipId, role},
      capabilities: [...capabilitiesForRole(role)],
    }
  })
}

/**
 * Every workspace in the organization, deleted ones included (their summary
 * carries `status`), newest first. `before` is the `workspaceId` of the last
 * item of the previous page.
 */
export async function listAllWorkspaces(opts: {limit: number; before?: string}): Promise<WorkspaceSummary[]> {
  const filter: Record<string, unknown> = {}
  if (opts.before) {
    const cursor = await WorkspaceModel.findOne({workspaceId: opts.before}).select({_id: 1}).lean()
    if (!cursor) fail("invalid_request", "unknown pagination cursor")
    filter._id = {$lt: cursor._id}
  }
  const rows = await WorkspaceModel.find(filter).sort({_id: -1}).limit(clampPageSize(opts.limit)).lean()
  return rows.map(toSummary)
}

export async function getActiveMembership(workspaceId: string, mentraUserId: string): Promise<MembershipRow | null> {
  if (!isId(mentraUserId)) return null
  return WorkspaceMembershipModel.findOne({workspaceId, mentraUserId, status: "active"}).lean<MembershipRow>()
}

/** Active memberships, oldest first. Migrated members who have not signed in yet are included. */
export async function listMembers(workspaceId: string): Promise<MembershipRow[]> {
  return WorkspaceMembershipModel.find({workspaceId, status: "active"})
    .sort({startedAt: 1, _id: 1})
    .lean<MembershipRow[]>()
}

/**
 * Every membership one person has had in a workspace, oldest first: ended rows are history, and the
 * active one (if any) has no `endedAt`. Only claimed rows can match, so a migrated membership still
 * waiting for its first sign-in belongs to nobody here.
 */
export async function listMembershipHistory(workspaceId: string, mentraUserId: string): Promise<MembershipRow[]> {
  // A missing id must not become a `null` filter, which would match every unclaimed row.
  if (!isId(workspaceId) || !isId(mentraUserId)) return []
  return WorkspaceMembershipModel.find({workspaceId, mentraUserId}).sort({startedAt: 1, _id: 1}).lean<MembershipRow[]>()
}

export async function countActiveOwners(workspaceId: string, session?: ClientSession): Promise<number> {
  return WorkspaceMembershipModel.countDocuments({workspaceId, role: "owner", status: "active"}).session(
    session ?? null,
  )
}

// --- Lifecycle -------------------------------------------------------------

/**
 * Create a workspace; the creator becomes its owner.
 *
 * `CLOUD_CORE_WORKSPACE_CREATION` is `open` (default) or `organization-admins`.
 * It is read at call time, and an unrecognized value throws rather than
 * silently opening creation up.
 */
export async function createWorkspace(actor: Actor & {kind: "user"}, input: {name: string}): Promise<WorkspaceSummary> {
  // An actor with no usable id would own a workspace nobody can ever be matched to.
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  const name = validateName(input?.name)
  if (creationPolicy() === "organization-admins" && !actor.isOrganizationAdmin) {
    fail("forbidden", "only organization admins can create workspaces")
  }
  const organization = organizationId()
  return withTransaction(async session => {
    const workspaceId = `ws_${ulid()}`
    const membershipId = `wm_${ulid()}`
    const now = new Date()
    await WorkspaceModel.create(
      [
        {
          workspaceId,
          organizationId: organization,
          name,
          status: "active",
          authorizationRevision: 0,
          createdByMentraUserId: actor.mentraUserId,
        },
      ],
      {session},
    )
    await WorkspaceMembershipModel.create(
      [
        {
          membershipId,
          organizationId: organization,
          workspaceId,
          mentraUserId: actor.mentraUserId,
          email: actor.email,
          name: displayName(actor.name),
          role: "owner",
          status: "active",
          startedAt: now,
        },
      ],
      {session},
    )
    await recordWorkspaceEvent(session, {
      organizationId: organization,
      workspaceId,
      action: "workspace.created",
      actor: auditActor(actor),
      target: {workspaceId, membershipId},
      after: {name, role: "owner"},
    })
    return {organizationId: organization, workspaceId, name, status: "active", authorizationRevision: 0}
  })
}

export async function renameWorkspace(
  actor: Actor,
  workspaceId: string,
  name: string,
  expectedRevision: number,
): Promise<WorkspaceSummary> {
  const newName = validateName(name)
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    assertRevision(workspace, expectedRevision)
    const role = await actingRole(session, actor, workspaceId)
    if (!role || !capabilitiesForRole(role).has("workspace.settings.manage")) {
      fail("forbidden", "renaming a workspace requires the admin role")
    }
    if (newName === workspace.name) return toSummary(workspace)

    const updated = await bumpRevision(session, workspaceId, expectedRevision, {name: newName})
    await recordWorkspaceEvent(session, {
      organizationId: workspace.organizationId,
      workspaceId,
      action: "workspace.renamed",
      actor: auditActor(actor),
      target: {workspaceId},
      before: {name: workspace.name},
      after: {name: newName},
    })
    return toSummary(updated)
  })
}

/**
 * Delete a workspace after confirming its name and checking, outside the
 * transaction (it calls the Store), that it owns no packages. Deleting ends
 * every membership, revokes every credential and pending invitation, and keeps
 * the workspace row (`status: "deleted"`) so audit history stays resolvable.
 *
 * A package published between the count and the deletion is not caught here:
 * the Store must refuse new packages for a workspace Core reports as deleted.
 */
export async function deleteWorkspace(
  actor: Actor,
  workspaceId: string,
  opts: {confirmName: string; ownedPackageCount: () => Promise<number>},
): Promise<void> {
  // Cheap refusals first, so the Store is only asked once the request is authorized and confirmed.
  await assertCanDelete(null, actor, workspaceId, opts.confirmName)

  let packages: number
  try {
    packages = await opts.ownedPackageCount()
  } catch (err) {
    logger.warn({err, workspaceId}, "could not count the workspace's packages")
    fail("store_unavailable", "could not check the workspace's packages with the Store")
  }
  if (!Number.isInteger(packages) || packages < 0) {
    fail("store_unavailable", "the Store returned an unusable package count")
  }
  if (packages > 0) {
    fail("workspace_has_packages", `the workspace still owns ${packages} package(s); transfer or delete them first`)
  }

  await withTransaction(async session => {
    // State may have changed while the Store was being asked; decide again on current data.
    const workspace = await assertCanDelete(session, actor, workspaceId, opts.confirmName)
    const now = new Date()
    await bumpRevision(session, workspaceId, undefined, {status: "deleted", deletedAt: now})
    await WorkspaceMembershipModel.updateMany(
      {workspaceId, status: "active"},
      {$set: {status: "ended", endedAt: now, endedReason: "workspace_deleted"}},
      {session},
    )
    await AccessCredentialModel.updateMany({workspaceId, revokedAt: null}, {$set: {revokedAt: now}}, {session})
    await WorkspaceInvitationModel.updateMany({workspaceId, status: "pending"}, {$set: {status: "revoked"}}, {session})
    await recordWorkspaceEvent(session, {
      organizationId: workspace.organizationId,
      workspaceId,
      action: "workspace.deleted",
      actor: auditActor(actor),
      target: {workspaceId},
      before: {name: workspace.name, status: "active"},
      after: {status: "deleted"},
    })
  })
}

async function assertCanDelete(
  session: ClientSession | null,
  actor: Actor,
  workspaceId: string,
  confirmName: string,
): Promise<WorkspaceRow> {
  const workspace = await loadActiveWorkspace(session, workspaceId)
  const role = await actingRole(session, actor, workspaceId)
  if (role !== "owner") fail("forbidden", "only a workspace owner or an organization admin can delete a workspace")
  if (confirmName !== workspace.name) fail("invalid_request", "confirmName does not match the workspace name")
  return workspace
}

// --- Memberships -----------------------------------------------------------

export async function changeRole(
  actor: Actor,
  workspaceId: string,
  membershipId: string,
  toRole: WorkspaceRole,
  expectedRevision: number,
): Promise<WorkspaceSummary> {
  if (!isWorkspaceRole(toRole)) fail("invalid_role", `role must be one of ${WORKSPACE_ROLES.join(", ")}`)
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    assertRevision(workspace, expectedRevision)
    const actorRole = await requireMembershipManager(session, actor, workspaceId)
    const target = await loadActiveMembership(session, workspaceId, membershipId)
    const fromRole = target.role as WorkspaceRole
    if (!canChangeRole(actorRole, fromRole, toRole)) {
      fail("forbidden", `a ${actorRole} cannot change a ${fromRole} to ${toRole}`)
    }
    if (fromRole === toRole) return toSummary(workspace)
    if (fromRole === "owner") await assertNotLastOwner(session, workspaceId)

    const updated = await bumpRevision(session, workspaceId, expectedRevision)
    const changed = await WorkspaceMembershipModel.updateOne(
      {membershipId, workspaceId, status: "active", role: fromRole},
      {$set: {role: toRole}},
      {session},
    )
    if (changed.modifiedCount !== 1) fail("membership_changed")
    await recordWorkspaceEvent(session, {
      organizationId: workspace.organizationId,
      workspaceId,
      action: "membership.role_changed",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: target.mentraUserId ?? null},
      before: {role: fromRole},
      after: {role: toRole},
    })
    return toSummary(updated)
  })
}

export async function removeMember(
  actor: Actor,
  workspaceId: string,
  membershipId: string,
  expectedRevision: number,
): Promise<WorkspaceSummary> {
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    assertRevision(workspace, expectedRevision)
    const actorRole = await requireMembershipManager(session, actor, workspaceId)
    const target = await loadActiveMembership(session, workspaceId, membershipId)
    const fromRole = target.role as WorkspaceRole
    if (!canChangeRole(actorRole, fromRole, null)) fail("forbidden", `a ${actorRole} cannot remove a ${fromRole}`)
    if (fromRole === "owner") await assertNotLastOwner(session, workspaceId)

    const updated = await bumpRevision(session, workspaceId, expectedRevision)
    return endMembership(session, {
      workspace: updated,
      actor,
      membership: target,
      reason: "removed",
      action: "membership.removed",
    })
  })
}

/** The actor leaves a workspace they belong to. The last owner cannot. */
export async function leaveWorkspace(actor: Actor & {kind: "user"}, workspaceId: string): Promise<void> {
  await withTransaction(async session => {
    await loadActiveWorkspace(session, workspaceId)
    const membership = isId(actor.mentraUserId)
      ? await WorkspaceMembershipModel.findOne({workspaceId, mentraUserId: actor.mentraUserId, status: "active"})
          .session(session)
          .lean<MembershipRow>()
      : null
    if (!membership) fail("not_found", "not a member of this workspace")
    if (membership.role === "owner") await assertNotLastOwner(session, workspaceId)

    const updated = await bumpRevision(session, workspaceId, undefined)
    await endMembership(session, {
      workspace: updated,
      actor,
      membership,
      reason: "left",
      action: "membership.left",
    })
  })
}

/**
 * Give `targetMentraUserId` the owner role, creating the membership if they
 * have none. Organization Admins (and the system) only: this is how a workspace
 * whose owners are all gone gets an owner again.
 */
export async function recoverOwnership(
  actor: Actor,
  workspaceId: string,
  targetMentraUserId: string,
): Promise<WorkspaceSummary> {
  if (!(actor.kind === "system" || (actor.kind === "user" && actor.isOrganizationAdmin))) {
    fail("forbidden", "only an organization admin can recover workspace ownership")
  }
  if (!isId(targetMentraUserId)) fail("invalid_request", "targetMentraUserId is required")
  const target = targetMentraUserId.trim()
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    const existing = await WorkspaceMembershipModel.findOne({workspaceId, mentraUserId: target, status: "active"})
      .session(session)
      .lean<MembershipRow>()
    if (existing?.role === "owner") return toSummary(workspace)

    const updated = await bumpRevision(session, workspaceId, undefined)
    let membershipId: string
    if (existing) {
      membershipId = existing.membershipId
      await WorkspaceMembershipModel.updateOne({membershipId, status: "active"}, {$set: {role: "owner"}}, {session})
    } else {
      membershipId = `wm_${ulid()}`
      await WorkspaceMembershipModel.create(
        [
          {
            membershipId,
            organizationId: workspace.organizationId,
            workspaceId,
            mentraUserId: target,
            role: "owner",
            status: "active",
            startedAt: new Date(),
          },
        ],
        {session},
      )
    }
    await recordWorkspaceEvent(session, {
      organizationId: workspace.organizationId,
      workspaceId,
      action: "membership.ownership_recovered",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: target},
      before: {role: existing ? existing.role : null},
      after: {role: "owner"},
    })
    return toSummary(updated)
  })
}

// --- Helpers ---------------------------------------------------------------
// The exported ones (`isId`, `isWorkspaceRole`, `validateName`, `loadActiveWorkspace`, `actingRole`,
// `requireMembershipManager`, `bumpRevision`, `auditActor`) are shared with `invitation.service` and
// `credential.service`, which follow the same mutation shape.

function toSummary(
  row: Pick<WorkspaceRow, "organizationId" | "workspaceId" | "name" | "status" | "authorizationRevision">,
): WorkspaceSummary {
  return {
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as WorkspaceSummary["status"],
    authorizationRevision: row.authorizationRevision ?? 0,
  }
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** A person's display name for a membership row: trimmed, or null when blank or not a string. Display only, never authorization. */
export function displayName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value)
}

export function validateName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : ""
  if (trimmed.length < 1 || trimmed.length > NAME_MAX_LENGTH) {
    fail("invalid_request", `name must be 1-${NAME_MAX_LENGTH} characters`)
  }
  return trimmed
}

function creationPolicy(): "open" | "organization-admins" {
  const configured = (process.env.CLOUD_CORE_WORKSPACE_CREATION ?? "").trim().toLowerCase()
  if (configured === "" || configured === "open") return "open"
  if (configured === "organization-admins") return "organization-admins"
  throw new Error('CLOUD_CORE_WORKSPACE_CREATION must be "open" or "organization-admins"')
}

export async function loadActiveWorkspace(session: ClientSession | null, workspaceId: string): Promise<WorkspaceRow> {
  const workspace = await WorkspaceModel.findOne({workspaceId}).session(session).lean<WorkspaceRow>()
  if (!workspace) fail("not_found", "workspace not found")
  if (workspace.status !== "active") fail("workspace_deleted", "workspace has been deleted")
  return workspace
}

async function loadActiveMembership(
  session: ClientSession,
  workspaceId: string,
  membershipId: string,
): Promise<MembershipRow> {
  const membership = await WorkspaceMembershipModel.findOne({membershipId, workspaceId, status: "active"})
    .session(session)
    .lean<MembershipRow>()
  if (!membership) fail("not_found", "membership not found")
  return membership
}

function assertRevision(workspace: WorkspaceRow, expectedRevision: number): void {
  if ((workspace.authorizationRevision ?? 0) !== expectedRevision) {
    fail("membership_changed", "the workspace's members or roles changed; reload and try again")
  }
}

/**
 * The role the actor acts with in this workspace. Organization Admins and the
 * system act as `owner` anywhere; a user otherwise has their membership's role;
 * service actors and non-members have none.
 */
export async function actingRole(
  session: ClientSession | null,
  actor: Actor,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  if (actor.kind === "system") return "owner"
  if (actor.kind !== "user") return null
  if (actor.isOrganizationAdmin) return "owner"
  if (!isId(actor.mentraUserId)) return null
  const membership = await WorkspaceMembershipModel.findOne({
    workspaceId,
    mentraUserId: actor.mentraUserId,
    status: "active",
  })
    .session(session)
    .lean<MembershipRow>()
  return membership ? (membership.role as WorkspaceRole) : null
}

/** Membership changes need at least the admin role, whoever is asking. */
export async function requireMembershipManager(
  session: ClientSession,
  actor: Actor,
  workspaceId: string,
): Promise<WorkspaceRole> {
  const role = await actingRole(session, actor, workspaceId)
  if (!role || !roleAtLeast(role, "admin")) fail("forbidden", "managing members requires the admin role")
  return role
}

async function assertNotLastOwner(session: ClientSession, workspaceId: string): Promise<void> {
  if ((await countActiveOwners(workspaceId, session)) <= 1) {
    fail("last_owner", "a workspace must keep at least one owner")
  }
}

/**
 * Increment `authorizationRevision` and apply `set`, requiring the revision to
 * still be `expectedRevision` when one is given. Every mutation calls this
 * before its other writes; it is what serializes concurrent mutations.
 */
export async function bumpRevision(
  session: ClientSession,
  workspaceId: string,
  expectedRevision: number | undefined,
  set: Record<string, unknown> = {},
): Promise<WorkspaceRow> {
  const filter: Record<string, unknown> = {workspaceId, status: "active"}
  if (expectedRevision !== undefined) filter.authorizationRevision = expectedRevision
  const update: Record<string, unknown> = {$inc: {authorizationRevision: 1}}
  if (Object.keys(set).length > 0) update.$set = set
  const updated = await WorkspaceModel.findOneAndUpdate(filter, update, {new: true, session}).lean<WorkspaceRow>()
  if (!updated) fail(expectedRevision === undefined ? "workspace_deleted" : "membership_changed")
  return updated
}

/** End a membership, revoke the credentials it created and record the audit event. */
async function endMembership(
  session: ClientSession,
  args: {
    workspace: WorkspaceRow
    actor: Actor
    membership: MembershipRow
    reason: "removed" | "left"
    action: "membership.removed" | "membership.left"
  },
): Promise<WorkspaceSummary> {
  const {workspace, actor, membership, reason, action} = args
  const now = new Date()
  const ended = await WorkspaceMembershipModel.updateOne(
    {membershipId: membership.membershipId, status: "active"},
    {$set: {status: "ended", endedAt: now, endedReason: reason}},
    {session},
  )
  if (ended.modifiedCount !== 1) fail("membership_changed")

  const credentials = await AccessCredentialModel.find({
    workspaceId: workspace.workspaceId,
    createdByMembershipId: membership.membershipId,
    revokedAt: null,
  })
    .select({_id: 0, credentialId: 1})
    .session(session)
    .lean()
  const revokedCredentialIds = credentials.map(credential => credential.credentialId)
  if (revokedCredentialIds.length > 0) {
    await AccessCredentialModel.updateMany(
      {credentialId: {$in: revokedCredentialIds}, revokedAt: null},
      {$set: {revokedAt: now}},
      {session},
    )
  }

  await recordWorkspaceEvent(session, {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    action,
    actor: auditActor(actor),
    target: {membershipId: membership.membershipId, mentraUserId: membership.mentraUserId ?? null},
    before: {role: membership.role, status: "active"},
    after: {status: "ended", endedReason: reason, revokedCredentialIds},
  })
  return toSummary(workspace)
}

export function auditActor(actor: Actor): WorkspaceAuditEventInput["actor"] {
  switch (actor.kind) {
    case "user":
      return {kind: "user", mentraUserId: actor.mentraUserId, ...(actor.email ? {email: actor.email} : {})}
    case "service":
      return {kind: "service", service: actor.service, ...(actor.email ? {email: actor.email} : {})}
    case "system":
      return {kind: "system"}
  }
}
