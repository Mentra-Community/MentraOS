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
 * The email is sent after the transaction commits, never inside the retried
 * callback, and a failed send never fails the invitation: the caller also gets
 * the link back.
 */

import {createHash, randomBytes} from "node:crypto"

import {createLogger} from "@mentra/cloud-shared"
import {canChangeRole, type WorkspaceRole} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {ulid} from "ulid"
import {withTransaction} from "../../connections/mongo.connection"
import {WorkspaceInvitationModel, type WorkspaceInvitationRow} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {sendEmail} from "../email/email.service"
import {recordWorkspaceEvent} from "./audit.service"
import {
  auditActor,
  bumpRevision,
  displayName,
  isId,
  isWorkspaceRole,
  loadActiveWorkspace,
  requireMembershipManager,
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
 * only the newest link works. `inviteUrl` is built from
 * `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE`, which must contain `{token}`; a
 * missing or unusable template throws a plain `Error` before anything is written.
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
          invitedByMembershipId: await actorMembershipId(session, actor, workspaceId),
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
        target: {invitationId: superseded.invitationId},
        before: {status: "pending", role: superseded.role},
        after: {status: "revoked", reason: "superseded", supersededBy: invitationId},
      })
    }
    await recordWorkspaceEvent(session, {
      workspaceId,
      action: "invitation.created",
      actor: auditActor(actor),
      target: {invitationId},
      after: {email, role, expiresAt},
    })
    return {invitationId, workspaceName: workspace.name, template}
  })

  const inviteUrl = created.template.split(TOKEN_PLACEHOLDER).join(token)
  await sendInvitationEmail({to: email, workspaceName: created.workspaceName, role, inviteUrl, expiresAt})
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
      target: {invitationId},
      before: {status: "pending", role},
      after: {status: "revoked"},
    })
  })
}

/**
 * What an invitation link is for, so the page can say who is being invited to
 * what before asking them to sign in. Null for an unknown, expired, used or
 * revoked token, and when the workspace is gone. Read-only.
 */
export async function peekInvitation(
  token: string,
): Promise<{workspaceName: string; email: string; role: WorkspaceRole} | null> {
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
  return {workspaceName: workspace.name, email: invitation.email, role: invitation.role as WorkspaceRole}
}

/**
 * Accept an invitation as `actor`: a new membership with the invited role.
 *
 * The actor's email must be verified and equal the invited address (case and
 * surrounding whitespace aside), otherwise `email_mismatch`. Order of refusals:
 * unknown, used or revoked token (`invitation_not_found`), expired
 * (`invitation_expired`), wrong or unverified email (`email_mismatch`), already
 * an active member (`already_member`; the invitation stays pending). One
 * transaction claims the invitation, inserts the membership under a new
 * `membershipId`, bumps `authorizationRevision` and records the audit events,
 * so a second accept of the same token finds nothing to claim.
 */
export async function acceptInvitation(
  actor: Actor & {kind: "user"},
  token: string,
): Promise<{workspaceId: string; membershipId: string}> {
  // An actor with no usable id would get a membership nobody can ever be matched to.
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  const tokenHash = hashTokenIfPlausible(token)
  if (!tokenHash) fail("invitation_not_found", "invitation not found")

  return withTransaction(async session => {
    const invitation = await WorkspaceInvitationModel.findOne({tokenHash, status: "pending"})
      .session(session)
      .lean<WorkspaceInvitationRow>()
    if (!invitation) fail("invitation_not_found", "invitation not found")
    await loadActiveWorkspace(session, invitation.workspaceId)

    if (invitation.expiresAt.getTime() <= Date.now()) fail("invitation_expired", "this invitation has expired")
    if (actor.emailVerified !== true || normalizeAddress(actor.email) !== invitation.email) {
      fail("email_mismatch", "sign in with the verified email address this invitation was sent to")
    }
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
    const role = invitation.role as WorkspaceRole
    const claimed = await WorkspaceInvitationModel.updateOne(
      {invitationId: invitation.invitationId, status: "pending"},
      {$set: {status: "accepted", acceptedMembershipId: membershipId}},
      {session},
    )
    if (claimed.modifiedCount !== 1) fail("invitation_not_found", "invitation not found")
    await bumpRevision(session, invitation.workspaceId, undefined)
    await WorkspaceMembershipModel.create(
      [
        {
          membershipId,
          workspaceId: invitation.workspaceId,
          mentraUserId: actor.mentraUserId,
          email: actor.email?.trim() || null,
          name: displayName(actor.name),
          role,
          status: "active",
          startedAt: new Date(),
        },
      ],
      {session},
    )

    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: "invitation.accepted",
      actor: auditActor(actor),
      target: {invitationId: invitation.invitationId, membershipId},
      before: {status: "pending"},
      after: {status: "accepted"},
    })
    await recordWorkspaceEvent(session, {
      workspaceId: invitation.workspaceId,
      action: "membership.added",
      actor: auditActor(actor),
      target: {membershipId, mentraUserId: actor.mentraUserId},
      before: {role: null},
      after: {role},
    })
    return {workspaceId: invitation.workspaceId, membershipId}
  })
}

// --- Helpers ---------------------------------------------------------------

/** The membership the actor invites from, or null (organization admins and the system may have none). */
async function actorMembershipId(session: ClientSession, actor: Actor, workspaceId: string): Promise<string | null> {
  if (actor.kind !== "user" || !isId(actor.mentraUserId)) return null
  const membership = await WorkspaceMembershipModel.findOne({
    workspaceId,
    mentraUserId: actor.mentraUserId,
    status: "active",
  })
    .select({membershipId: 1})
    .session(session)
    .lean()
  return membership?.membershipId ?? null
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
 * `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE`: an absolute http(s) URL
 * containing `{token}`, e.g. `https://console.example.com/invite/{token}`. Read
 * at call time; a missing or unusable value throws rather than minting a link
 * that cannot work.
 */
function inviteUrlTemplate(): string {
  const template = process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE?.trim() ?? ""
  const problem = `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE must be an absolute http(s) URL containing "${TOKEN_PLACEHOLDER}"`
  if (!template.includes(TOKEN_PLACEHOLDER)) throw new Error(problem)
  let sample: URL
  try {
    sample = new URL(template.split(TOKEN_PLACEHOLDER).join("sample"))
  } catch {
    throw new Error(problem)
  }
  if (sample.protocol !== "https:" && sample.protocol !== "http:") throw new Error(problem)
  return template
}

/** Best effort: log and carry on, so a mail outage never blocks inviting. */
async function sendInvitationEmail(args: {
  to: string
  workspaceName: string
  role: WorkspaceRole
  inviteUrl: string
  expiresAt: Date
}): Promise<void> {
  const {to, workspaceName, role, inviteUrl, expiresAt} = args
  try {
    const name = escapeHtml(workspaceName)
    const link = escapeHtml(inviteUrl)
    const result = await sendEmail({
      to,
      subject: `You're invited to join ${workspaceName} on Mentra`,
      html:
        `<p>You've been invited to join the <strong>${name}</strong> workspace as ${escapeHtml(role)}.</p>` +
        `<p><a href="${link}">Accept the invitation</a></p>` +
        `<p>Or open this link: ${link}</p>` +
        `<p>Sign in with this email address (${escapeHtml(to)}) to accept. The invitation expires on ` +
        `${escapeHtml(expiresAt.toUTCString())}.</p>`,
    })
    if (!result.ok && !result.skipped) logger.warn("invitation email was not sent")
  } catch (err) {
    logger.warn({err}, "invitation email failed")
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
