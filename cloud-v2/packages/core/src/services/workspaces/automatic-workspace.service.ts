/**
 * @fileoverview The automatic workspace: every person who signs in to the workspace portal has a workspace.
 *
 * `ensureWorkspace` answers the person's workspace, making one when they have none
 * (`POST /workspaces/ensure`). In one transaction it:
 *
 *  1. refuses a deleted account (`account_deleted`);
 *  2. writes the person's `users` row (`portalWorkspaceAt`), so two ensures at once, two tabs or a retry
 *     racing its own first try, conflict on that row and the one retried finds what the other made;
 *  3. answers the workspace of the person's oldest active membership, when they have one, whatever made it;
 *  4. otherwise applies `createWorkspace`'s rules (a verified email, `CLOUD_CORE_WORKSPACE_CREATION`) and
 *     inserts a workspace marked `automatic: true`, with the person as its Owner, recording
 *     `workspace.created` with `after.automatic: true`.
 *
 * Its name is the person's (`automaticWorkspaceName`): from Core's sign-in record and verified email only,
 * so nothing here assumes a Mentra account. Core does not look at invitations: the portal decides whether
 * to ensure at all, and an automatic workspace made where an invitation would have done gives way.
 *
 * Giving way is for a workspace that **holds nothing** (`holdsNothing`, `replaceableWorkspaces`): it is
 * active and automatic, the person's Owner membership is its only active membership (an imported one
 * waiting for its person counts as another), and it has no pending invitation that has not expired, no
 * unrevoked key, no license that has not ended and no deletion hold. The workspace list marks such a
 * workspace `replaceable`.
 */

import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel} from "../../models/access-credential.model"
import {LicenseModel} from "../../models/license.model"
import {UserModel} from "../../models/user.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import type {MembershipSummary, WorkspaceRole, WorkspaceSummary} from "@mentra/workspace-contract"
import {memberNames} from "./member-names.service"
import {fail} from "./workspace-error"
import {
  assertMayCreateWorkspace,
  deletionHoldsOf,
  insertWorkspace,
  isId,
  refuseDeletedAccount,
  WORKSPACE_NAME_MAX_LENGTH,
  type Actor,
} from "./workspace.service"

const NAME_SUFFIX = "'s Workspace"
const NAMELESS = "My Workspace"

/** What `ensureWorkspace` answers: the person's workspace, their membership in it, and whether it was just made. */
export interface EnsuredWorkspace {
  created: boolean
  workspace: WorkspaceSummary
  membership: MembershipSummary
}

/**
 * The name of a person's automatic workspace: their sign-in `name` (trimmed, inner whitespace and control
 * characters collapsed to one space) and "'s Workspace". Without a name, the `email`'s local part with any
 * `+tag` dropped, split on `.`, `_` and `-`, each word's first letter capitalized, joined by spaces
 * (`john.smith+x@…` is "John Smith's Workspace"). Without either, "My Workspace". The person's part is cut,
 * never inside a character, so the whole is at most 80 characters.
 */
export function automaticWorkspaceName(person: {name?: string | null; email?: string | null}): string {
  const own = clean(person.name) || nameFromEmail(person.email)
  if (!own) return NAMELESS
  return `${cut(own, WORKSPACE_NAME_MAX_LENGTH - NAME_SUFFIX.length)}${NAME_SUFFIX}`
}

/**
 * The person's workspace: 200's existing one or 201's new automatic one (see the file header). Refused:
 * a non-person (`forbidden`), a deleted account (`account_deleted`), an account Core has no record of
 * (`user_not_found`), and, only when there is no workspace to answer, an unverified email
 * (`email_unverified`) or a non-admin where only Organization Admins may create workspaces (`forbidden`).
 */
export async function ensureWorkspace(actor: Actor & {kind: "user"}): Promise<EnsuredWorkspace> {
  if (actor?.kind !== "user" || !isId(actor.mentraUserId)) fail("forbidden", "a signed-in user is required")
  const mentraUserId = actor.mentraUserId
  return withTransaction(async session => {
    await refuseDeletedAccount(session, mentraUserId)
    await serializeEnsures(session, mentraUserId)

    const existing = await oldestWorkspaceOf(session, mentraUserId)
    if (existing) return {created: false, ...existing}

    assertMayCreateWorkspace(actor)
    // The name is cosmetic, so it is read outside the transaction's snapshot.
    const signInName = (await memberNames([mentraUserId])).get(mentraUserId)
    const name = automaticWorkspaceName({name: signInName, email: actor.email})
    return {created: true, ...(await insertWorkspace(session, actor, {name, automatic: true}))}
  })
}

/**
 * Whether the person's automatic workspace `workspaceId` holds nothing (see the file header), read in
 * `session`: what lets it give way inside the transaction that gives the person a membership elsewhere.
 */
export async function holdsNothing(
  session: ClientSession,
  workspaceId: string,
  mentraUserId: string,
): Promise<boolean> {
  return (await workspacesHoldingNothing(session, mentraUserId, [workspaceId])).has(workspaceId)
}

/**
 * Which of `workspaceIds` are the person's automatic workspaces that hold nothing: one read per check for
 * all of them.
 */
export async function replaceableWorkspaces(
  mentraUserId: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  return workspacesHoldingNothing(null, mentraUserId, workspaceIds)
}

// --- Helpers ---------------------------------------------------------------

/**
 * Write the person's `users` row in this transaction, so a concurrent ensure's write conflicts with it.
 * `portalWorkspaceAt` becomes now, or a millisecond past its value when the clock has not passed it: a write
 * that changed nothing would conflict with nothing.
 */
async function serializeEnsures(session: ClientSession, mentraUserId: string): Promise<void> {
  const now = new Date()
  const written = await UserModel.updateOne(
    {mentraUserId},
    [{$set: {portalWorkspaceAt: {$max: [now, {$add: [{$ifNull: ["$portalWorkspaceAt", new Date(0)]}, 1]}]}}}],
    {session},
  )
  if (written.matchedCount !== 1) fail("user_not_found", "no such account")
}

/** The workspace of the person's oldest active membership, with that membership, or null. */
async function oldestWorkspaceOf(
  session: ClientSession,
  mentraUserId: string,
): Promise<{workspace: WorkspaceSummary; membership: MembershipSummary} | null> {
  const memberships = await WorkspaceMembershipModel.find({mentraUserId, status: "active"})
    .sort({startedAt: 1, _id: 1})
    .select({_id: 0, workspaceId: 1, membershipId: 1, role: 1})
    .session(session)
    .lean<Array<{workspaceId: string; membershipId: string; role: WorkspaceRole}>>()
  if (memberships.length === 0) return null
  const workspaces = await WorkspaceModel.find({
    workspaceId: {$in: memberships.map(row => row.workspaceId)},
    status: "active",
  })
    .session(session)
    .lean()
  const active = new Map(workspaces.map(row => [row.workspaceId, row]))
  const oldest = memberships.find(row => active.has(row.workspaceId))
  if (!oldest) return null
  const row = active.get(oldest.workspaceId)!
  return {
    workspace: {
      workspaceId: row.workspaceId,
      name: row.name,
      status: "active",
      authorizationRevision: row.authorizationRevision ?? 0,
    },
    membership: {membershipId: oldest.membershipId, role: oldest.role},
  }
}

/**
 * Which of `workspaceIds` hold nothing for `mentraUserId`. Each check is one read for all of them, and a
 * check runs only on the workspaces every earlier one left.
 */
async function workspacesHoldingNothing(
  session: ClientSession | null,
  mentraUserId: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  // A missing id must not become a `null` filter.
  if (!isId(mentraUserId)) return new Set()
  let left = [...new Set(workspaceIds.filter(isId))]
  if (left.length === 0) return new Set()

  // Active, automatic, and no deletion hold.
  const workspaces = await WorkspaceModel.find({workspaceId: {$in: left}, status: "active", automatic: true})
    .select({_id: 0, workspaceId: 1, deletionHolds: 1})
    .session(session)
    .lean()
  left = workspaces.filter(row => deletionHoldsOf(row).length === 0).map(row => row.workspaceId)
  if (left.length === 0) return new Set()

  // The person's Owner membership is the only active one.
  const members = await WorkspaceMembershipModel.aggregate<{_id: string; active: number; ownOwner: number}>([
    {$match: {workspaceId: {$in: left}, status: "active"}},
    {
      $group: {
        _id: "$workspaceId",
        active: {$sum: 1},
        ownOwner: {
          $sum: {$cond: [{$and: [{$eq: ["$mentraUserId", mentraUserId]}, {$eq: ["$role", "owner"]}]}, 1, 0]},
        },
      },
    },
  ]).session(session)
  const alone = new Set(members.filter(row => row.active === 1 && row.ownOwner === 1).map(row => row._id))
  left = left.filter(workspaceId => alone.has(workspaceId))
  if (left.length === 0) return new Set()

  // No pending invitation anyone can still accept.
  const invited = await WorkspaceInvitationModel.distinct("workspaceId", {
    workspaceId: {$in: left},
    status: "pending",
    expiresAt: {$gt: new Date()},
  }).session(session)
  left = without(left, invited)
  if (left.length === 0) return new Set()

  // No unrevoked key.
  const keyed = await AccessCredentialModel.distinct("workspaceId", {
    workspaceId: {$in: left},
    revokedAt: null,
  }).session(session)
  left = without(left, keyed)
  if (left.length === 0) return new Set()

  // No license that has not ended.
  const licensed = await LicenseModel.distinct("owner.workspaceId", {
    "owner.type": "workspace",
    "owner.workspaceId": {$in: left},
    endedAt: null,
  }).session(session)
  return new Set(without(left, licensed))
}

function without(ids: string[], taken: unknown[]): string[] {
  const out = new Set(taken.filter((id): id is string => typeof id === "string"))
  return ids.filter(id => !out.has(id))
}

/** Trimmed, with every run of whitespace or control characters one space; "" for anything but a string. */
function clean(value: unknown): string {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
}

function nameFromEmail(email: unknown): string {
  if (typeof email !== "string") return ""
  const at = email.lastIndexOf("@")
  if (at <= 0) return ""
  const local = email.slice(0, at).split("+")[0]!
  return clean(
    local
      .split(/[._-]+/)
      .filter(word => word.length > 0)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
  )
}

/** `value` cut to at most `max` UTF-16 units, never inside a character, and with no trailing space. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  let out = ""
  for (const char of value) {
    if (out.length + char.length > max) break
    out += char
  }
  return out.trimEnd()
}
