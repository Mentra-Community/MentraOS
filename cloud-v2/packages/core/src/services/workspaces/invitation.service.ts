/**
 * @fileoverview Workspace invitations.
 *
 * An invitation names a workspace, an email address, a role and an expiry. The
 * invitee proves the address by signing in with it verified, then accepts with
 * the token from the link. Only the SHA-256 hash of the token is stored, so a
 * database read cannot be turned into a working link.
 *
 * Mutations follow the shape of `workspace.service`: one transaction that
 * loads the workspace, checks the actor, writes, and records its audit events
 * last. Concurrency rests on write conflicts, which `withTransaction` retries:
 *  - creating an invitation touches the workspace document, so it conflicts
 *    with every other mutation of that workspace (including its deletion);
 *  - revoking and accepting both write the invitation document, so a revoke
 *    and an accept of one invitation cannot both succeed;
 *  - accepting also bumps `authorizationRevision`, since it adds a membership.
 *
 * Expiry is evaluated when an invitation is read (`expiresAt` against now);
 * nothing flips a stored status when time passes, and peeking never writes.
 *
 * An invitation is found one of two ways: by the token in its link (`peek`,
 * `accept`), or, for the person it is addressed to, by their verified email
 * (`listInvitationsForPerson`, then `acceptInvitationById`), as people who sign
 * in without the link expect. Both ways accept through one function with the
 * same checks; only how the pending invitation is looked up differs.
 *
 * An invitation is only as good as the authority it was sent with, recorded on
 * it (`invitedByAuthority`) and checked again when it is peeked at or accepted:
 * the inviter's membership must still grant the role, or the inviter must still
 * be an Organization Admin whose account is not deleted. Ending the inviter's
 * membership, or deleting their account, also revokes what they sent.
 *
 * The email is sent after the transaction commits, never inside the retried
 * callback, and a failed send never fails the invitation: the caller also gets
 * the link back. It names the inviter by their email address (`invitation-email`).
 *
 * Every audit event about an invitation names the invited address in its
 * target (`target.email`), and the membership an accepted invitation starts
 * names the member's, so the audit log can say whose invitation or membership
 * it was without another lookup.
 */

import {createHash, randomBytes} from "node:crypto"

import {createLogger} from "@mentra/cloud-shared"
import {
  canChangeRole,
  INVITATION_DECLINED_ACTION,
  type InvitationPreview,
  type WorkspaceRole,
} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {ulid} from "ulid"
import {withTransaction} from "../../connections/mongo.connection"
import {UserModel} from "../../models/user.model"
import {
  WorkspaceInvitationModel,
  type InviterAuthority,
  type WorkspaceInvitationRow,
} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {isOrganizationAdminEmail} from "../admin-email-policy"
import {sendEmail} from "../email/email.service"
import {consumeRateLimit} from "../signin/rate-limit.service"
import {isDeletedAccountId} from "../user.service"
import {recordWorkspaceEvent} from "./audit.service"
import {acquireGuard} from "./membership-guard.service"
import {invitationEmail} from "./invitation-email"
import {
  auditActor,
  bumpRevision,
  isId,
  isWorkspaceRole,
  loadActiveWorkspace,
  refuseDeletedAccount,
  requireMembershipManager,
  roleEntry,
  touchWorkspace,
  type Actor,
} from "./workspace.service"
import {fail} from "./workspace-error"

const logger = createLogger("core").child({service: "invitation.service"})

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** RFC 5321: the longest forward-path an address can have. */
const EMAIL_MAX_LENGTH = 254
/** Tokens are 43 base64url characters; anything much longer is not one and is not worth hashing. */
const TOKEN_MAX_LENGTH = 256
const TOKEN_PLACEHOLDER = "{token}"
/** Invitations one person may send per hour, across workspaces: invitation emails carry Mentra's name. */
const INVITATIONS_PER_PERSON_PER_HOUR = 100
/** Pending invitations one workspace may hold at once. */
const MAX_PENDING_INVITATIONS = 200
/** The most invitations listed to the person they are addressed to (one per workspace can be pending). */
const MAX_INVITATIONS_FOR_PERSON = 100
/** Pending rows read per batch while looking for those; and the most read in all, so one request stays bounded. */
const INVITATION_SCAN_BATCH = 100
const MAX_INVITATIONS_SCANNED = 1000

/** An invitation as listed to administrators. It never includes the token or its hash. */
export interface InvitationRow {
  invitationId: string
  workspaceId: string
  email: string
  role: WorkspaceRole
  status: "pending"
  invitedByMembershipId: string | null
  expiresAt: Date
  acceptedMembershipId: string | null
  createdAt: Date
}

/**
 * Invite `input.email` to the workspace with `input.role`.
 *
 * The actor needs at least the admin role and `canChangeRole(actorRole, null,
 * role)`: admins invite members and developers, only owners invite admins and
 * owners. A person inviting must have a verified email (`email_unverified`
 * otherwise). A pending invitation to the same address is revoked (superseded), so
 * only the newest link works. A person may send at most 100 invitations an hour
 * and a workspace hold at most 200 pending ones (`rate_limited`); replacing the
 * pending invitation to an address does not count against that. The invitation
 * records the authority it is sent with (`inviterOf`). `inviteUrl` is
 * built from `inviteUrlTemplate()`; a missing or unusable template is
 * `invitations_unavailable` (503), before anything is written.
 * The template is checked only once the workspace exists and the actor may
 * invite this role, so a caller who may not invite is refused (404, 410, 403)
 * whatever the deployment's configuration says.
 */
export async function createInvitation(
  actor: Actor,
  workspaceId: string,
  input: {email: string; role: WorkspaceRole},
): Promise<{invitationId: string; inviteUrl: string; expiresAt: Date}> {
  const email = normalizeInviteEmail(input?.email)
  const role = input?.role
  if (!isWorkspaceRole(role)) fail("invalid_role", "role must be a workspace role")

  if (actor.kind === "user" && isId(actor.mentraUserId)) {
    const withinLimit = await consumeRateLimit(`workspace-invitations:${actor.mentraUserId}`, INVITATIONS_PER_PERSON_PER_HOUR, 3600)
    if (!withinLimit) fail("rate_limited", "too many invitations sent in the last hour; try again later")
  }

  const token = randomBytes(32).toString("base64url")
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

  const created = await withTransaction(async session => {
    const workspace = await loadActiveWorkspace(session, workspaceId)
    const actorRole = await requireMembershipManager(session, actor, workspaceId)
    if (!canChangeRole(actorRole, null, role)) fail("forbidden", `a ${actorRole} cannot invite a ${role}`)
    // Invitations send Mentra-branded email in the inviter's name, so the inviter's address must be verified.
    if (actor.kind === "user" && actor.emailVerified !== true) {
      fail("email_unverified", "verify your email address before inviting people")
    }
    // Only now, for a caller who may invite: a configuration problem is the operator's to hear about, not a stranger's.
    const template = inviteUrlTemplate()
    await touchWorkspace(session, workspaceId)
    // The pending invitation to this address, if any, is replaced below, so it does not count.
    const pending = await WorkspaceInvitationModel.countDocuments({
      workspaceId,
      status: "pending",
      expiresAt: {$gt: new Date()},
      email: {$ne: email},
    }).session(session)
    if (pending >= MAX_PENDING_INVITATIONS) {
      fail("rate_limited", "this workspace has too many pending invitations; revoke some before inviting more")
    }

    const inviter = await inviterOf(session, actor, workspaceId, role)
    const invitationId = `winv_${ulid()}`
    const superseded = await WorkspaceInvitationModel.findOneAndUpdate(
      {workspaceId, email, status: "pending"},
      {$set: {status: "revoked"}},
      {session},
    ).lean<WorkspaceInvitationRow>()
    await WorkspaceInvitationModel.create(
      [
        {
          invitationId,
          workspaceId,
          email,
          role,
          tokenHash,
          status: "pending",
          ...inviter,
          expiresAt,
        },
      ],
      {session},
    )

    if (superseded) {
      await recordWorkspaceEvent(session, {
        workspaceId,
        action: "invitation.revoked",
        actor: auditActor(actor),
        target: {invitationId: superseded.invitationId, email: superseded.email},
        before: {status: "pending", role: superseded.role},
        after: {status: "revoked", reason: "superseded", supersededBy: invitationId},
      })
    }
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "invitation.created",
      actor: auditActor(actor),
      target: {invitationId, email},
      after: {email, role, expiresAt},
    })
    return {invitationId, workspaceName: workspace.name, template}
  })

  const inviteUrl = created.template.split(TOKEN_PLACEHOLDER).join(token)
  await sendInvitationEmail({
    to: email,
    workspaceName: created.workspaceName,
    role,
    inviteUrl,
    expiresAt,
    invitedBy: inviterAddress(actor),
  })
  return {invitationId: created.invitationId, inviteUrl, expiresAt}
}

/**
 * The workspace's invitations that can still be accepted, oldest first: pending
 * and not yet expired. Authorization is the caller's job.
 */
export async function listPendingInvitations(workspaceId: string): Promise<InvitationRow[]> {
  const rows = await WorkspaceInvitationModel.find({workspaceId, status: "pending", expiresAt: {$gt: new Date()}})
    .sort({_id: 1})
    .lean<WorkspaceInvitationRow[]>()
  // Built field by field rather than stripped, so a column added to the model
  // later (the token hash is one) cannot leak through this list.
  return rows.map(row => ({
    invitationId: row.invitationId,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role as WorkspaceRole,
    status: "pending",
    invitedByMembershipId: row.invitedByMembershipId ?? null,
    expiresAt: row.expiresAt,
    acceptedMembershipId: row.acceptedMembershipId ?? null,
    createdAt: row.createdAt,
  }))
}

/**
 * Revoke a pending invitation of this workspace. The same rule as inviting
 * applies to its role: an admin cannot revoke an admin or owner invitation.
 * An invitation that is not pending (or belongs to another workspace) is
 * `invitation_not_found`.
 */
export async function revokeInvitation(actor: Actor, workspaceId: string, invitationId: string): Promise<void> {
  await withTransaction(async session => {
    await loadActiveWorkspace(session, workspaceId)
    const actorRole = await requireMembershipManager(session, actor, workspaceId)
    const invitation = await WorkspaceInvitationModel.findOne({invitationId, workspaceId, status: "pending"})
      .session(session)
      .lean<WorkspaceInvitationRow>()
    if (!invitation) fail("invitation_not_found", "invitation not found")
    const role = invitation.role as WorkspaceRole
    if (!canChangeRole(actorRole, null, role)) fail("forbidden", `a ${actorRole} cannot revoke a ${role} invitation`)

    const revoked = await WorkspaceInvitationModel.updateOne(
      {invitationId, status: "pending"},
      {$set: {status: "revoked"}},
      {session},
    )
    if (revoked.modifiedCount !== 1) fail("invitation_not_found", "invitation not found")
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "invitation.revoked",
      actor: auditActor(actor),
      target: {invitationId, email: invitation.email},
      before: {status: "pending", role},
      after: {status: "revoked"},
    })
  })
}

/**
 * What an invitation link is for, so the page can say who invited whom to what before asking them to
 * sign in. Null for an unknown, expired, used or revoked token, when the workspace is gone, and when the
 * inviter's authority no longer grants the role. Read-only.
 */
export async function peekInvitation(token: string): Promise<InvitationPreview | null> {
  const tokenHash = hashTokenIfPlausible(token)
  if (!tokenHash) return null
  const invitation = await WorkspaceInvitationModel.findOne({
    tokenHash,
    status: "pending",
    expiresAt: {$gt: new Date()},
  }).lean<WorkspaceInvitationRow>()
  if (!invitation) return null
  const workspace = await WorkspaceModel.findOne({workspaceId: invitation.workspaceId, status: "active"})
    .select({name: 1})
    .lean()
  if (!workspace) return null
  if (!(await inviterStillAuthorizes(null, invitation))) return null
  return toPreview(invitation, workspace.name, (await inviterEmails([invitation])).get(invitation.invitationId) ?? null)
}

/**
 * The invitations addressed to the signed-in person that they can accept now, newest first: pending,
 * not expired, to an active workspace they are not already in, from an inviter whose authority still
 * grants the role. Matched on the person's verified email, case aside; never carries a token. At most
 * 100, found among the newest 1,000 pending rows for the address.
 *
 * Refused like accepting: a key or an actor with no id (`forbidden`), an unverified or missing email
 * (`email_unverified`), a deleted account (`account_deleted`).
 */
export async function listInvitationsForPerson(actor: Actor & {kind: "user"}): Promise<InvitationPreview[]> {
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  const email = normalizeAddress(actor.email)
  if (actor.emailVerified !== true || !email) {
    fail("email_unverified", "verify your email address to see the invitations sent to it")
  }
  if (await isDeletedAccountId(actor.mentraUserId)) fail("account_deleted", "this account is deleted")

  // Read newest first in batches and keep what can be accepted: the cap applies to those, so unusable
  // rows (a deleted workspace, one they are in, a lapsed inviter) never crowd out older usable ones.
  const now = new Date()
  const live: Array<{row: WorkspaceInvitationRow; workspaceName: string}> = []
  let before: unknown = null
  for (let scanned = 0; scanned < MAX_INVITATIONS_SCANNED && live.length < MAX_INVITATIONS_FOR_PERSON; ) {
    const filter: Record<string, unknown> = {email, status: "pending", expiresAt: {$gt: now}}
    if (before !== null) filter._id = {$lt: before}
    const rows = await WorkspaceInvitationModel.find(filter)
      .sort({_id: -1})
      .limit(INVITATION_SCAN_BATCH)
      .lean<Array<WorkspaceInvitationRow & {_id: unknown}>>()
    if (rows.length === 0) break
    scanned += rows.length
    before = rows[rows.length - 1]!._id
    for (const entry of await acceptableFor(actor.mentraUserId, rows)) {
      if (live.length < MAX_INVITATIONS_FOR_PERSON) live.push(entry)
    }
    if (rows.length < INVITATION_SCAN_BATCH) break
  }
  const inviters = await inviterEmails(live.map(entry => entry.row))
  return live.map(({row, workspaceName}) => toPreview(row, workspaceName, inviters.get(row.invitationId) ?? null))
}

/**
 * Of `rows` (pending, unexpired, addressed to the person), in order, those they can accept: the
 * workspace is active, they are not already in it, and the inviter's authority still grants the role.
 */
async function acceptableFor(
  mentraUserId: string,
  rows: WorkspaceInvitationRow[],
): Promise<Array<{row: WorkspaceInvitationRow; workspaceName: string}>> {
  const workspaceIds = [...new Set(rows.map(row => row.workspaceId))]
  const [workspaces, memberships] = await Promise.all([
    WorkspaceModel.find({workspaceId: {$in: workspaceIds}, status: "active"}).select({workspaceId: 1, name: 1}).lean(),
    WorkspaceMembershipModel.find({workspaceId: {$in: workspaceIds}, mentraUserId, status: "active"})
      .select({workspaceId: 1})
      .lean(),
  ])
  const names = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace.name]))
  // Accepting into a workspace they are already in is refused (`already_member`), so it is not offered.
  const joined = new Set(memberships.map(membership => membership.workspaceId))
  const acceptable: Array<{row: WorkspaceInvitationRow; workspaceName: string}> = []
  for (const row of rows) {
    const workspaceName = names.get(row.workspaceId)
    if (workspaceName === undefined || joined.has(row.workspaceId)) continue
    if (!(await inviterStillAuthorizes(null, row))) continue
    acceptable.push({row, workspaceName})
  }
  return acceptable
}

/**
 * Accept an invitation as `actor`: a new membership with the invited role.
 *
 * The actor's email must be verified and equal the invited address (case and
 * surrounding whitespace aside), otherwise `email_mismatch`. Order of refusals:
 * unknown, used or revoked token (`invitation_not_found`), expired
 * (`invitation_expired`), an inviter whose authority no longer grants the role
 * (`invitation_not_found`), wrong or unverified email (`email_mismatch`), a
 * deleted account (`account_deleted`; deleted accounts are no principals), already
 * an active member (`already_member`; the invitation stays pending). One
 * transaction claims the invitation, inserts the membership under a new
 * `membershipId`, bumps `authorizationRevision` and records the audit events,
 * so a second accept of the same token finds nothing to claim.
 */
export async function acceptInvitation(
  actor: Actor & {kind: "user"},
  token: string,
): Promise<{workspaceId: string; membershipId: string}> {
  const tokenHash = hashTokenIfPlausible(token)
  return acceptPendingInvitation(actor, tokenHash ? {tokenHash} : null)
}

/**
 * Accept the invitation `invitationId` as `actor`, the person it is addressed to: what the invitations
 * listed by `listInvitationsForPerson` offer. Exactly the checks, order and outcome of
 * {@link acceptInvitation}; only the lookup differs. The verified-email match is what authorizes it, as
 * it is for a token.
 */
export async function acceptInvitationById(
  actor: Actor & {kind: "user"},
  invitationId: string,
): Promise<{workspaceId: string; membershipId: string}> {
  return acceptPendingInvitation(actor, isId(invitationId) ? {invitationId} : null)
}

/** Accept the pending invitation `lookup` finds (none: `invitation_not_found`). See {@link acceptInvitation}. */
async function acceptPendingInvitation(
  actor: Actor & {kind: "user"},
  lookup: {tokenHash: string} | {invitationId: string} | null,
): Promise<{workspaceId: string; membershipId: string}> {
  // An actor with no usable id would get a membership nobody can ever be matched to.
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  if (!lookup) fail("invitation_not_found", "invitation not found")

  return withTransaction(async session => {
    const invitation = await WorkspaceInvitationModel.findOne({...lookup, status: "pending"})
      .session(session)
      .lean<WorkspaceInvitationRow>()
    if (!invitation) fail("invitation_not_found", "invitation not found")
    await loadActiveWorkspace(session, invitation.workspaceId)

    if (invitation.expiresAt.getTime() <= Date.now()) fail("invitation_expired", "this invitation has expired")
    // The invitation is only as good as its inviter's standing today.
    if (!(await inviterStillAuthorizes(session, invitation))) {
      fail("invitation_not_found", "this invitation is no longer valid; ask for a new one")
    }
    if (actor.emailVerified !== true || normalizeAddress(actor.email) !== invitation.email) {
      fail("email_mismatch", "sign in with the verified email address this invitation was sent to")
    }
    await refuseDeletedAccount(session, actor.mentraUserId)
    const existing = await WorkspaceMembershipModel.findOne({
      workspaceId: invitation.workspaceId,
      mentraUserId: actor.mentraUserId,
      status: "active",
    })
      .select({membershipId: 1})
      .session(session)
      .lean()
    if (existing) fail("already_member", "already a member of this workspace")

    const membershipId = `wm_${ulid()}`
    // One workspace per person: another workspace refuses the accept (`already_in_workspace`, 409), and a
    // concurrent accept elsewhere loses at the guard's insert rather than at a check that has passed.
    await acquireGuard(session, actor.mentraUserId, {workspaceId: invitation.workspaceId, membershipId})
    const role = invitation.role as WorkspaceRole
    const memberEmail = actor.email?.trim() || null
    const claimed = await WorkspaceInvitationModel.updateOne(
      {invitationId: invitation.invitationId, status: "pending"},
      {$set: {status: "accepted", acceptedMembershipId: membershipId}},
      {session},
    )
    if (claimed.modifiedCount !== 1) fail("invitation_not_found", "invitation not found")
    const updated = await bumpRevision(session, invitation.workspaceId, undefined)
    const now = new Date()
    await WorkspaceMembershipModel.create(
      [
        {
          membershipId,
          workspaceId: invitation.workspaceId,
          mentraUserId: actor.mentraUserId,
          email: memberEmail,
          role,
          roleHistory: [roleEntry(role, now, updated.authorizationRevision)],
          status: "active",
          startedAt: now,
        },
      ],
      {session},
    )

    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: "invitation.accepted",
      actor: auditActor(actor),
      target: {invitationId: invitation.invitationId, membershipId, email: invitation.email},
      before: {status: "pending"},
      after: {status: "accepted"},
    })
    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: "membership.added",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: actor.mentraUserId, email: memberEmail},
      before: {role: null},
      after: {role},
    })
    return {workspaceId: invitation.workspaceId, membershipId}
  })
}

/**
 * Decline the invitation `invitationId` as `actor`, the person it is addressed to. Authorized exactly as
 * accepting is (a verified email equal to the invited address, otherwise `email_mismatch`), but it asks
 * nothing of the inviter or the expiry: a person can always turn an invitation down, even one that has
 * lapsed or whose inviter has since lost the authority to send it.
 *
 * Declining twice is idempotent. A revoked, accepted or unknown invitation is `invitation_not_found`.
 * Nothing about a membership changes (so the change feed's `membership.*` events, and Fleet's membership
 * intervals, are untouched); the audit event `invitation.declined` is the only record, and a later
 * invitation to the same address can be sent as usual (the declined row no longer counts as pending).
 */
export async function declineInvitation(
  actor: Actor & {kind: "user"},
  invitationId: string,
): Promise<{invitationId: string; declined: true}> {
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  if (!isId(invitationId)) fail("invitation_not_found", "invitation not found")

  return withTransaction(async session => {
    const invitation = await WorkspaceInvitationModel.findOne({
      invitationId,
      status: {$in: ["pending", "declined"]},
    })
      .session(session)
      .lean<WorkspaceInvitationRow>()
    if (!invitation) fail("invitation_not_found", "invitation not found")
    if (actor.emailVerified !== true || normalizeAddress(actor.email) !== invitation.email) {
      fail("email_mismatch", "sign in with the verified email address this invitation was sent to")
    }
    await refuseDeletedAccount(session, actor.mentraUserId)
    if (invitation.status === "declined") return {invitationId, declined: true as const}

    const declined = await WorkspaceInvitationModel.updateOne(
      {invitationId, status: "pending"},
      {$set: {status: "declined"}},
      {session},
    )
    if (declined.modifiedCount !== 1) fail("invitation_not_found", "invitation not found")
    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: INVITATION_DECLINED_ACTION,
      actor: auditActor(actor),
      target: {invitationId, email: invitation.email},
      before: {status: "pending", role: invitation.role},
      after: {status: "declined"},
    })
    return {invitationId, declined: true as const}
  })
}

/**
 * Revoke, inside the caller's transaction, every pending invitation `mentraUserId` sent, whatever
 * authority it was sent with, and record each as revoked by `actor` with `reason`. Returns the ids
 * it revoked. Account deletion uses it.
 */
export async function revokeInvitationsSentBy(
  session: ClientSession,
  mentraUserId: string,
  actor: Actor,
  reason: string,
): Promise<string[]> {
  if (!isId(mentraUserId)) return []
  const invitations = await WorkspaceInvitationModel.find({invitedByMentraUserId: mentraUserId, status: "pending"})
    .sort({_id: 1})
    .session(session)
    .lean<WorkspaceInvitationRow[]>()
  const revoked: string[] = []
  for (const invitation of invitations) {
    const result = await WorkspaceInvitationModel.updateOne(
      {invitationId: invitation.invitationId, status: "pending"},
      {$set: {status: "revoked"}},
      {session},
    )
    if (result.modifiedCount !== 1) continue
    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: "invitation.revoked",
      actor: auditActor(actor),
      target: {invitationId: invitation.invitationId, email: invitation.email},
      before: {status: "pending", role: invitation.role},
      after: {status: "revoked", reason},
    })
    revoked.push(invitation.invitationId)
  }
  return revoked
}

// --- Helpers ---------------------------------------------------------------

/** Who sent an invitation, and on what authority: the fields an invitation records about its inviter. */
interface Inviter {
  invitedByAuthority: InviterAuthority
  invitedByMembershipId: string | null
  invitedByMentraUserId: string | null
  invitedByEmail: string | null
}

/**
 * The authority `actor` invites `role` with. A membership whose role grants it comes first: such an
 * invitation stays valid while that membership could still send it. Otherwise an Organization Admin
 * invites on the organization's authority, recorded with the verified email that made them one; such
 * an invitation stays valid while that email is on the admin allowlist and the account exists. The
 * system needs neither. The caller has already checked that the actor may invite this role.
 */
async function inviterOf(
  session: ClientSession,
  actor: Actor,
  workspaceId: string,
  role: WorkspaceRole,
): Promise<Inviter> {
  if (actor.kind === "system") {
    return {invitedByAuthority: "system", invitedByMembershipId: null, invitedByMentraUserId: null, invitedByEmail: null}
  }
  if (actor.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "only a person can send an invitation")
  const membership = await WorkspaceMembershipModel.findOne({
    workspaceId,
    mentraUserId: actor.mentraUserId,
    status: "active",
  })
    .select({membershipId: 1, role: 1})
    .session(session)
    .lean()
  if (membership && canChangeRole(membership.role as WorkspaceRole, null, role)) {
    return {
      invitedByAuthority: "membership",
      invitedByMembershipId: membership.membershipId,
      invitedByMentraUserId: actor.mentraUserId,
      invitedByEmail: null,
    }
  }
  const email = normalizeAddress(actor.email)
  if (!actor.isOrganizationAdmin || !isOrganizationAdminEmail({email: email || null, verified: actor.emailVerified === true})) {
    fail("forbidden", `you cannot invite a ${role}`)
  }
  return {
    invitedByAuthority: "organization_admin",
    invitedByMembershipId: null,
    invitedByMentraUserId: actor.mentraUserId,
    invitedByEmail: email,
  }
}

/** Whether the authority an invitation was sent with still grants its role. */
async function inviterStillAuthorizes(
  session: ClientSession | null,
  invitation: WorkspaceInvitationRow,
): Promise<boolean> {
  const role = invitation.role as WorkspaceRole
  switch (invitation.invitedByAuthority) {
    case "membership": {
      if (!isId(invitation.invitedByMembershipId)) return false
      const inviter = await WorkspaceMembershipModel.findOne({
        membershipId: invitation.invitedByMembershipId,
        workspaceId: invitation.workspaceId,
        status: "active",
      })
        .select({role: 1})
        .session(session)
        .lean()
      return !!inviter && canChangeRole(inviter.role as WorkspaceRole, null, role)
    }
    case "organization_admin": {
      if (!isId(invitation.invitedByMentraUserId)) return false
      if (!isOrganizationAdminEmail({email: invitation.invitedByEmail ?? null, verified: true})) return false
      // A deleted account keeps its users row as a tombstone; it authorizes nothing.
      const account = await UserModel.exists({
        mentraUserId: invitation.invitedByMentraUserId,
        supportTelemetryDeletedAt: null,
      }).session(session)
      return account !== null
    }
    case "system":
      return true
    default:
      return false
  }
}

/** An invitation as the person it is addressed to sees it. Never the token or its hash. */
function toPreview(row: WorkspaceInvitationRow, workspaceName: string, invitedByEmail: string | null): InvitationPreview {
  return {
    invitationId: row.invitationId,
    workspaceId: row.workspaceId,
    workspaceName,
    email: row.email,
    role: row.role as WorkspaceRole,
    invitedByEmail,
    expiresAt: row.expiresAt.toISOString(),
  }
}

/**
 * The address each invitation names as its inviter, by invitation id: the Organization Admin's recorded
 * email, or the display email of the membership it was sent from. None for the system, or once account
 * deletion has cleared it.
 */
async function inviterEmails(rows: WorkspaceInvitationRow[]): Promise<Map<string, string | null>> {
  const membershipIds = [...new Set(rows.map(row => row.invitedByMembershipId).filter(isId))]
  const memberships = membershipIds.length
    ? await WorkspaceMembershipModel.find({membershipId: {$in: membershipIds}}).select({membershipId: 1, email: 1}).lean()
    : []
  const byMembership = new Map(memberships.map(membership => [membership.membershipId, membership.email ?? null]))
  return new Map(
    rows.map(row => [
      row.invitationId,
      row.invitedByEmail ?? (isId(row.invitedByMembershipId) ? (byMembership.get(row.invitedByMembershipId) ?? null) : null),
    ]),
  )
}

function normalizeAddress(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : ""
}

/** Trim, lowercase, and require one "@" with something on both sides, no whitespace, at most 254 characters. */
function normalizeInviteEmail(email: unknown): string {
  const normalized = normalizeAddress(email)
  const at = normalized.indexOf("@")
  const valid =
    normalized.length > 0 &&
    normalized.length <= EMAIL_MAX_LENGTH &&
    at > 0 &&
    at < normalized.length - 1 &&
    at === normalized.lastIndexOf("@") &&
    !/\s/.test(normalized)
  if (!valid) fail("invalid_request", "email must be a valid address of at most 254 characters")
  return normalized
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** The hash to look a presented token up by, or null when it cannot be a token. */
function hashTokenIfPlausible(token: unknown): string | null {
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_LENGTH) return null
  return hashToken(token)
}

/**
 * The invitation link template: `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE`, an
 * absolute http(s) URL containing `{token}`, or by default the workspace portal's
 * accept page, `<CLOUD_CORE_ENTERPRISE_PORTAL_URL origin>/?workspaceInvite={token}`.
 * Read at call time; a missing or unusable value throws rather than minting a
 * link that cannot work.
 */
export function inviteUrlTemplate(): string {
  const template = process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE?.trim() || defaultInviteUrlTemplate()
  const problem =
    `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE must be an absolute http(s) URL containing "${TOKEN_PLACEHOLDER}", ` +
    "or CLOUD_CORE_ENTERPRISE_PORTAL_URL must be set so invitation links open the workspace portal"
  const unusable = (): never => {
    logger.error(problem)
    fail("invitations_unavailable", "invitations are not configured on this deployment")
  }
  if (!template.includes(TOKEN_PLACEHOLDER)) unusable()
  let sample: URL | null = null
  try {
    sample = new URL(template.split(TOKEN_PLACEHOLDER).join("sample"))
  } catch {
    unusable()
  }
  if (sample!.protocol !== "https:" && sample!.protocol !== "http:") unusable()
  return template
}

/** The workspace portal's accept page, when the workspace portal's URL is configured. */
function defaultInviteUrlTemplate(): string {
  const portal = process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL?.trim()
  if (!portal) return ""
  try {
    return `${new URL(portal).origin}/?workspaceInvite=${TOKEN_PLACEHOLDER}`
  } catch {
    return ""
  }
}

/** The inviter the email names: a person's (verified) address; nobody when the system invites. */
function inviterAddress(actor: Actor): string | null {
  return actor.kind === "user" ? actor.email?.trim() || null : null
}

/** Best effort: log and carry on, so a mail outage never blocks inviting. */
async function sendInvitationEmail(args: {
  to: string
  workspaceName: string
  role: WorkspaceRole
  inviteUrl: string
  expiresAt: Date
  invitedBy: string | null
}): Promise<void> {
  try {
    const {subject, html, text} = invitationEmail(args)
    const result = await sendEmail({to: args.to, subject, html, text})
    if (!result.ok && !result.skipped) logger.warn("invitation email was not sent")
  } catch (err) {
    logger.warn({err}, "invitation email failed")
  }
}
