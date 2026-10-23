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
 * later re-join is a new row with a new `membershipId`. Ending one releases the
 * license seats it holds in the same transaction (`license.service`), so a
 * rejoined member has none. Every write that starts
 * a membership or changes its role appends the role to its `roleHistory` in the
 * same update, stamped with the workspace revision that write produced.
 *
 * Every membership event names the member in its target: `membershipId`,
 * `mentraUserId` and `email`, the display address the membership records (null
 * when it records none), so the audit log can say whose membership it was.
 */

import {
  canChangeRole,
  capabilitiesForRole,
  describeDeletionHolds,
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
import {UserModel} from "../../models/user.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {
  WorkspaceMembershipModel,
  type WorkspaceMembershipEndedReason,
  type WorkspaceMembershipRow,
} from "../../models/workspace-membership.model"
import {legacyIdentityClaims} from "../../models/legacy-browser-identity.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {endLicensesForOwner, releaseSeatsForMembership, seatReleaseReasonFor} from "../licenses/license.service"
import {isDeletedAccountId} from "../user.service"
import {yieldAutomaticWorkspace} from "./automatic-workspace.service"
import {deletionHoldsOf, replaceableWorkspaces} from "./workspace-holdings"
import {clampPageSize, recordWorkspaceEvent, type WorkspaceAuditEventInput} from "./audit.service"
import {workspaceCreationPolicy} from "./organization"
import {fail, WorkspaceError, type WorkspaceErrorCode} from "./workspace-error"

/** The longest a workspace name may be. */
export const WORKSPACE_NAME_MAX_LENGTH = 80

/**
 * Who is acting. For a user, `emailVerified` says whether the identity provider
 * verified `email`; anything that matches on the address (accepting an
 * invitation) requires it.
 */
export type Actor =
  | {
      kind: "user"
      mentraUserId: string
      email: string | null
      emailVerified: boolean
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
 * The workspaces a person belongs to, oldest first. Deleted workspaces are left out. Each says whether it
 * is `replaceable`: the person's own automatic workspace, which they own, while it holds nothing
 * (`replaceableWorkspaces`). That is asked only about such workspaces, all of them at once, so a person
 * with none asks nothing more. A caller that does not use it passes `{replaceable: false}`: nothing is
 * asked, and the items carry no `replaceable`.
 */
export async function listWorkspacesForUser(
  mentraUserId: string,
  opts: {replaceable?: boolean} = {},
): Promise<PrincipalResponse["workspaces"]> {
  // A missing id must not become a `null` filter.
  if (!isId(mentraUserId)) return []
  const memberships = await WorkspaceMembershipModel.find({mentraUserId, status: "active"}).lean()
  if (memberships.length === 0) return []
  const byWorkspace = new Map(memberships.map(row => [row.workspaceId, row]))
  const workspaces = await WorkspaceModel.find({workspaceId: {$in: [...byWorkspace.keys()]}, status: "active"})
    .sort({_id: 1})
    .lean()
  const ownAutomatic = workspaces
    .filter(workspace => workspace.automatic === true && byWorkspace.get(workspace.workspaceId)!.role === "owner")
    .map(workspace => workspace.workspaceId)
  const askReplaceable = opts.replaceable !== false
  const replaceable =
    askReplaceable && ownAutomatic.length > 0 ? await replaceableWorkspaces(mentraUserId, ownAutomatic) : new Set()
  return workspaces.map(workspace => {
    const membership = byWorkspace.get(workspace.workspaceId)!
    const role = membership.role as WorkspaceRole
    return {
      ...toSummary(workspace),
      membership: {membershipId: membership.membershipId, role},
      capabilities: [...capabilitiesForRole(role)],
      ...(askReplaceable ? {replaceable: replaceable.has(workspace.workspaceId)} : {}),
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

/** Active memberships, oldest first, imported ones still waiting for their person's first sign-in included. */
export async function listMembers(workspaceId: string): Promise<MembershipRow[]> {
  return WorkspaceMembershipModel.find({workspaceId, status: "active"})
    .sort({startedAt: 1, _id: 1})
    .lean<MembershipRow[]>()
}

/**
 * Which of `legacyUserIds` (the Store's former user ids that imported memberships wait under) a person
 * can still take up memberships for: their legacy identity is not claimed yet, or is claimed by an
 * account that is not deleted (it takes up what waits at its next sign-in). Without an identity, or
 * claimed by a deleted account, nobody ever will.
 */
export async function claimableLegacyUserIds(legacyUserIds: string[], session?: ClientSession): Promise<Set<string>> {
  const identities = await legacyIdentityClaims(legacyUserIds, session)
  const claimants = identities.flatMap(identity => (isId(identity.claimedBy) ? [identity.claimedBy] : []))
  const deleted = new Set(
    claimants.length
      ? (
          await UserModel.find({mentraUserId: {$in: claimants}, supportTelemetryDeletedAt: {$ne: null}})
            .select({_id: 0, mentraUserId: 1})
            .session(session ?? null)
            .lean<Array<{mentraUserId: string}>>()
        ).map(user => user.mentraUserId)
      : [],
  )
  return new Set(
    identities
      .filter(identity => !isId(identity.claimedBy) || !deleted.has(identity.claimedBy))
      .map(identity => identity.legacyUserId),
  )
}

/**
 * The workspace's active owners who can still act: a deleted account's owner membership never
 * counts (its deletion ends it, and Core finishes an interrupted deletion itself), so the last-owner
 * guard cannot rest on an owner nobody can sign in as. An imported owner membership still waiting
 * for its person counts while it can still be taken up (`claimableLegacyUserIds`); otherwise (no
 * identity was exported, the export removed it because the address is no longer verified, or the
 * account that claimed it is deleted) nobody ever will, so it does not count.
 */
export async function countActiveOwners(workspaceId: string, session?: ClientSession): Promise<number> {
  const owners = await WorkspaceMembershipModel.find({workspaceId, role: "owner", status: "active"})
    .select({_id: 0, mentraUserId: 1, pendingWorkosUserId: 1})
    .session(session ?? null)
    .lean<Array<{mentraUserId?: string | null; pendingWorkosUserId?: string | null}>>()
  const userIds = owners.flatMap(owner => (isId(owner.mentraUserId) ? [owner.mentraUserId] : []))
  const waitingFor = owners.flatMap(owner =>
    !isId(owner.mentraUserId) && isId(owner.pendingWorkosUserId) ? [owner.pendingWorkosUserId] : [],
  )
  const deleted = userIds.length
    ? await UserModel.countDocuments({mentraUserId: {$in: userIds}, supportTelemetryDeletedAt: {$ne: null}}).session(
        session ?? null,
      )
    : 0
  const claimable = await claimableLegacyUserIds(waitingFor, session)
  return userIds.length - deleted + waitingFor.filter(legacyUserId => claimable.has(legacyUserId)).length
}

// --- Lifecycle -------------------------------------------------------------

/**
 * Create a workspace; the creator becomes its owner. The creator's email must be
 * verified (`email_unverified` otherwise): a workspace's name goes out in its
 * invitation emails, so only someone the identity provider vouches for may make one.
 * A deleted account is no principal; should one reach here it is refused
 * (`account_deleted`).
 *
 * `CLOUD_CORE_WORKSPACE_CREATION` (`workspaceCreationPolicy`) is `open` (default)
 * or `organization-admins`.
 */
export async function createWorkspace(actor: Actor & {kind: "user"}, input: {name: string}): Promise<WorkspaceSummary> {
  // An actor with no usable id would own a workspace nobody can ever be matched to.
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  // An unverified email is refused before a bad name, and a bad name before the creation policy.
  // `assertMayCreateWorkspace` checks the email again; this one only keeps that order.
  if (actor.emailVerified !== true) {
    fail("email_unverified", "verify your email address before creating a workspace")
  }
  const name = validateName(input?.name)
  assertMayCreateWorkspace(actor)
  return withTransaction(async session => {
    await refuseDeletedAccount(session, actor.mentraUserId)
    return (await insertWorkspace(session, actor, {name, automatic: false})).workspace
  })
}

/**
 * Who may create a workspace: a person whose email is verified (`email_unverified`), and under
 * `CLOUD_CORE_WORKSPACE_CREATION=organization-admins` only an Organization Admin (`forbidden`).
 */
export function assertMayCreateWorkspace(actor: Actor & {kind: "user"}): void {
  if (actor.emailVerified !== true) {
    fail("email_unverified", "verify your email address before creating a workspace")
  }
  if (workspaceCreationPolicy() === "organization-admins" && !actor.isOrganizationAdmin) {
    fail("forbidden", "only organization admins can create workspaces")
  }
}

/**
 * Insert a workspace with `actor` as its Owner, inside the caller's transaction, and record
 * `workspace.created`. `automatic` marks a person's automatic workspace (`automatic-workspace.service`), and
 * its event's `after` says so; any other workspace has no such field. The caller has already checked who
 * may create one (`assertMayCreateWorkspace`) and refused a deleted account.
 */
export async function insertWorkspace(
  session: ClientSession,
  actor: Actor & {kind: "user"},
  input: {name: string; automatic: boolean},
): Promise<{workspace: WorkspaceSummary; membership: {membershipId: string; role: "owner"}}> {
  const name = validateName(input.name)
  const workspaceId = `ws_${ulid()}`
  const membershipId = `wm_${ulid()}`
  const now = new Date()
  await WorkspaceModel.create(
    [
      {
        workspaceId,
        name,
        status: "active",
        authorizationRevision: 0,
        createdByMentraUserId: actor.mentraUserId,
        ...(input.automatic ? {automatic: true} : {}),
      },
    ],
    {session},
  )
  await WorkspaceMembershipModel.create(
    [
      {
        membershipId,
        workspaceId,
        mentraUserId: actor.mentraUserId,
        email: actor.email,
        role: "owner",
        roleHistory: [roleEntry("owner", now, 0)],
        status: "active",
        startedAt: now,
      },
    ],
    {session},
  )
  await recordWorkspaceEvent(session, {
    workspaceId,
    action: "workspace.created",
    actor: auditActor(actor),
    target: {workspaceId, membershipId},
    after: {name, role: "owner", ...(input.automatic ? {automatic: true} : {})},
  })
  return {
    workspace: {workspaceId, name, status: "active", authorizationRevision: 0},
    membership: {membershipId, role: "owner"},
  }
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
 * Delete a workspace after confirming its name. Deleting ends every membership,
 * revokes every credential and pending invitation, ends the workspace's licenses
 * and releases their seats (`endLicensesForOwner`), bumps the authorization
 * revision, and keeps the workspace row (`status: "deleted"`) so audit history
 * stays resolvable and its id is never reused. It records `workspace.deleted`.
 *
 * Only an owner (an Organization Admin, the system) may, and not while any
 * service holds the workspace (`deletion-hold.service`): that is 409
 * `workspace_has_holds`, whoever asks, with the holds in the error's details and
 * what they mean in its message. The holds are checked after who may delete
 * (someone who may not learns nothing about them) and before the typed name.
 *
 * Core asks no other service at delete time: a service that needs a workspace
 * kept holds it beforehand. The Store holds a workspace while it owns a miniapp
 * that is not deleted, a draft included. Whatever else a service keeps for a deleted workspace is that
 * service's to handle; it learns of the deletion from the change feed.
 */
export async function deleteWorkspace(actor: Actor, workspaceId: string, opts: {confirmName: string}): Promise<void> {
  await withTransaction(async session => {
    const workspace = await assertCanDelete(session, actor, workspaceId, opts.confirmName)
    await deleteWorkspaceIn(session, workspace, actor)
  })
}

/**
 * Every step of deleting `workspace` after the checks of who may and whether it should be, in the
 * caller's transaction: the workspace row becomes `deleted` (one revision bump, which serializes the
 * deletion with any other change there), its active memberships end (`workspace_deleted`), its keys
 * and pending invitations are revoked, its licenses end and release their seats, and `workspace.deleted`
 * is recorded for `actor`. `after` is merged into that event's `after` (`{status: "deleted", ...after}`).
 * `deleteWorkspace` calls it after `assertCanDelete`; giving way to another workspace
 * (`yieldAutomaticWorkspace`) calls it after finding the workspace holds nothing.
 */
export async function deleteWorkspaceIn(
  session: ClientSession,
  workspace: Pick<WorkspaceRow, "workspaceId" | "name">,
  actor: Actor,
  after: Record<string, unknown> = {},
): Promise<void> {
  const {workspaceId} = workspace
  const now = new Date()
  await bumpRevision(session, workspaceId, undefined, {status: "deleted", deletedAt: now})
  await WorkspaceMembershipModel.updateMany(
    {workspaceId, status: "active"},
    {$set: {status: "ended", endedAt: now, endedReason: "workspace_deleted"}},
    {session},
  )
  await AccessCredentialModel.updateMany({workspaceId, revokedAt: null}, {$set: {revokedAt: now}}, {session})
  await WorkspaceInvitationModel.updateMany({workspaceId, status: "pending"}, {$set: {status: "revoked"}}, {session})
  await endLicensesForOwner(session, {type: "workspace", workspaceId}, "workspace_deleted", actor)
  await recordWorkspaceEvent(session, {
    workspaceId,
    action: "workspace.deleted",
    actor: auditActor(actor),
    target: {workspaceId},
    before: {name: workspace.name, status: "active"},
    after: {status: "deleted", ...after},
  })
}

async function assertCanDelete(
  session: ClientSession,
  actor: Actor,
  workspaceId: string,
  confirmName: string,
): Promise<WorkspaceRow> {
  const workspace = await loadActiveWorkspace(session, workspaceId)
  const role = await actingRole(session, actor, workspaceId)
  if (role !== "owner") fail("forbidden", "only a workspace owner or an organization admin can delete a workspace")
  // A hold set concurrently writes this same document, so the delete's write conflicts with it and the
  // retried transaction sees the hold here.
  const holds = deletionHoldsOf(workspace)
  if (holds.length > 0) fail("workspace_has_holds", describeDeletionHolds(holds), {holds})
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
    if (fromRole === "owner") await assertNotLastOwner(session, workspaceId, target)

    const updated = await bumpRevision(session, workspaceId, expectedRevision)
    const changed = await WorkspaceMembershipModel.updateOne(
      {membershipId, workspaceId, status: "active", role: fromRole},
      {$set: {role: toRole}, $push: {roleHistory: roleEntry(toRole, new Date(), updated.authorizationRevision)}},
      {session},
    )
    if (changed.modifiedCount !== 1) fail("membership_changed")
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "membership.role_changed",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: target.mentraUserId ?? null, email: target.email ?? null},
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
    if (fromRole === "owner") await assertNotLastOwner(session, workspaceId, target)

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
    if (membership.role === "owner") await assertNotLastOwner(session, workspaceId, membership)

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
 * whose owners are all gone gets an owner again. The target must be a Core user
 * whose account is not deleted (`user_not_found` otherwise): a deleted account
 * keeps its users row as a tombstone, and an owner nobody can sign in as would
 * still count for the last-owner guard.
 *
 * `opts.email` is the person's confirmed account address when the caller named
 * them by it: a new membership records it for display, and the audit event names
 * it (an existing membership keeps, and the event names, the address it has).
 */
export async function recoverOwnership(
  actor: Actor,
  workspaceId: string,
  targetMentraUserId: string,
  opts: {email?: string | null} = {},
): Promise<WorkspaceSummary> {
  if (!(actor.kind === "system" || (actor.kind === "user" && actor.isOrganizationAdmin))) {
    fail("forbidden", "only an organization admin can recover workspace ownership")
  }
  if (!isId(targetMentraUserId)) fail("invalid_request", "targetMentraUserId is required")
  const target = targetMentraUserId.trim()
  return withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    if (!(await UserModel.exists({mentraUserId: target, supportTelemetryDeletedAt: null}).session(session))) {
      fail("user_not_found", "no such person")
    }
    const existing = await WorkspaceMembershipModel.findOne({workspaceId, mentraUserId: target, status: "active"})
      .session(session)
      .lean<MembershipRow>()
    if (existing?.role === "owner") return toSummary(workspace)

    const updated = await bumpRevision(session, workspaceId, undefined)
    const now = new Date()
    const owner = roleEntry("owner", now, updated.authorizationRevision)
    const email = existing ? (existing.email ?? null) : opts.email?.trim() || null
    let membershipId: string
    if (existing) {
      membershipId = existing.membershipId
      await WorkspaceMembershipModel.updateOne(
        {membershipId, status: "active"},
        {$set: {role: "owner"}, $push: {roleHistory: owner}},
        {session},
      )
    } else {
      // A person who gains a workspace here no longer needs an empty automatic one of their own.
      await yieldAutomaticWorkspace(session, actor, target, {except: workspaceId})
      membershipId = `wm_${ulid()}`
      await WorkspaceMembershipModel.create(
        [
          {
            membershipId,
            workspaceId,
            mentraUserId: target,
            email,
            role: "owner",
            roleHistory: [owner],
            status: "active",
            startedAt: now,
          },
        ],
        {session},
      )
    }
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "membership.ownership_recovered",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: target, email},
      before: {role: existing ? existing.role : null},
      after: {role: "owner"},
    })
    return toSummary(updated)
  })
}

// --- Helpers ---------------------------------------------------------------
// The exported ones (`isId`, `isWorkspaceRole`, `validateName`, `loadActiveWorkspace`, `actingRole`,
// `requireMembershipManager`, `bumpRevision`, `touchWorkspace`, `endMembership`, `auditActor`) are shared
// with `invitation.service`, `credential.service`, `account-deletion.service` and `license.service`, which
// follow the same mutation shape.

function toSummary(
  row: Pick<WorkspaceRow, "workspaceId" | "name" | "status" | "authorizationRevision">,
): WorkspaceSummary {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as WorkspaceSummary["status"],
    authorizationRevision: row.authorizationRevision ?? 0,
  }
}

/**
 * A `roleHistory` entry: `role`, held from `from`, granted by the write that took the workspace to
 * `authorizationRevision`. The entry lasts until the next one starts or the membership ends.
 */
export function roleEntry(
  role: WorkspaceRole,
  from: Date,
  authorizationRevision: number,
): {role: WorkspaceRole; from: Date; authorizationRevision: number} {
  return {role, from, authorizationRevision}
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value)
}

export function validateName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : ""
  if (trimmed.length < 1 || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    fail("invalid_request", `name must be 1-${WORKSPACE_NAME_MAX_LENGTH} characters`)
  }
  // Names go into invitation emails' subjects and bodies: no line breaks or other control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) fail("invalid_request", "name must not contain control characters")
  return trimmed
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

/**
 * Refuse a deleted account (`account_deleted`, 403) inside a transaction that would give it a
 * membership. Deleted accounts are no principals; this is the guard behind that.
 */
export async function refuseDeletedAccount(session: ClientSession, mentraUserId: string): Promise<void> {
  if (await isDeletedAccountId(mentraUserId, session)) fail("account_deleted", "this account is deleted")
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

/**
 * Refuse removing or demoting `owner` when it is the workspace's last live owner. A deleted account's
 * owner membership, and an imported one nobody can claim, are no live owners: removing or demoting
 * them is always allowed (and they never count toward the others, `countActiveOwners`).
 */
async function assertNotLastOwner(session: ClientSession, workspaceId: string, owner: MembershipRow): Promise<void> {
  if (await isDeletedAccountId(owner.mentraUserId, session)) return
  // An imported owner nobody can claim is no owner either (`countActiveOwners`).
  if (!isId(owner.mentraUserId)) {
    const waitingFor = isId(owner.pendingWorkosUserId) ? [owner.pendingWorkosUserId] : []
    if ((await claimableLegacyUserIds(waitingFor, session)).size === 0) return
  }
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

/**
 * Write the workspace document without changing anything it holds, so this
 * transaction usually conflicts with a concurrent mutation of the workspace
 * without invalidating anyone's `expectedRevision`. Invitations and credentials
 * use it: they do not change who holds which role. It is not a guarantee: when
 * `updatedAt` already holds the same instant the write is a no-op and conflicts
 * with nothing. Seat changes are serialized by the license's conditional
 * increment and the feed counter instead.
 */
export async function touchWorkspace(session: ClientSession, workspaceId: string): Promise<void> {
  const touched = await WorkspaceModel.updateOne(
    {workspaceId, status: "active"},
    {$set: {updatedAt: new Date()}},
    {session},
  )
  if (touched.matchedCount !== 1) fail("workspace_deleted", "workspace has been deleted")
}

/**
 * End a membership, revoke the credentials it created and the invitations it
 * sent, release the license seats it holds (`seat.released`, reason
 * `member_removed`, `member_left` or `account_deleted`), and record the audit
 * event. The caller has already bumped the workspace's revision in the same
 * transaction. Ending closes the membership's last `roleHistory` entry at
 * `endedAt`, so nothing is appended to it.
 */
export async function endMembership(
  session: ClientSession,
  args: {
    workspace: WorkspaceRow
    actor: Actor
    membership: MembershipRow
    reason: Exclude<WorkspaceMembershipEndedReason, "workspace_deleted">
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

  // An invitation carries its inviter's authority, which ends with the membership.
  const invitations = await WorkspaceInvitationModel.find({
    workspaceId: workspace.workspaceId,
    invitedByMembershipId: membership.membershipId,
    status: "pending",
  })
    .select({_id: 0, invitationId: 1})
    .session(session)
    .lean()
  const revokedInvitationIds = invitations.map(invitation => invitation.invitationId)
  if (revokedInvitationIds.length > 0) {
    await WorkspaceInvitationModel.updateMany(
      {invitationId: {$in: revokedInvitationIds}, status: "pending"},
      {$set: {status: "revoked"}},
      {session},
    )
  }

  // A seat belongs to this membership: it ends with it, and a later membership of the same person starts with none.
  await releaseSeatsForMembership(session, membership, seatReleaseReasonFor(reason), actor)

  await recordWorkspaceEvent(session, {
    workspaceId: workspace.workspaceId,
    action,
    actor: auditActor(actor),
    target: {
      membershipId: membership.membershipId,
      mentraUserId: membership.mentraUserId ?? null,
      email: membership.email ?? null,
    },
    before: {role: membership.role, status: "active"},
    after: {status: "ended", endedReason: reason, revokedCredentialIds, revokedInvitationIds},
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
