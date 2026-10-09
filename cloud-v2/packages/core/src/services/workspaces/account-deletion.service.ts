/**
 * @fileoverview What deleting a Mentra account does to workspaces.
 *
 * One transaction, as the deleted user:
 *  - ends every active membership the user holds, and every still-unclaimed migrated membership
 *    waiting for a WorkOS user linked to them, with `endedReason: "account_deleted"`. Each ends as
 *    removal does (`endMembership`): the workspace's revision is bumped, the credentials that
 *    membership created are revoked, and one `membership.removed` event is recorded;
 *  - deletes the user's identity links, so a later sign-in with the same WorkOS user is linked
 *    afresh (to a new Mentra user, once the account is gone) instead of reviving this one;
 *  - records the `user.deleted` tombstone last: `workspaceId` null, target `{mentraUserId}`. It is
 *    on the change feed, so a service holding data keyed by this user knows to delete it.
 *
 * Account deletion is never refused for a workspace's sake. A workspace whose last owner this was
 * is left without one, and an Organization Admin recovers it (`recoverOwnership`).
 *
 * Pending invitations the user sent stay valid. An invitation does not depend on its inviter's
 * membership (accepting checks the invitation, the workspace and the invitee only), which is also
 * what removing an inviter does. Invitations addressed to the user's email stay too: they name an
 * address, not an account.
 *
 * Organization operator keys the user created are not revoked here: an operator key works only
 * while its creator's email is on the Organization Admin allowlist, and the allowlist, not the
 * account, decides that.
 */

import {USER_DELETED_ACTION} from "@mentra/workspace-contract"
import {withTransaction} from "../../connections/mongo.connection"
import {IdentityLinkModel} from "../../models/identity-link.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {recordWorkspaceEvent} from "./audit.service"
import {auditActor, endMembership, isId, type Actor, type MembershipRow} from "./workspace.service"

/**
 * End the deleted user's workspace access and record the tombstone, in one transaction. Safe to run
 * again: a second run finds nothing left to end and records another tombstone, which a feed reader
 * handles like the first.
 */
export async function removeDeletedUserFromWorkspaces(mentraUserId: string): Promise<{endedMembershipIds: string[]}> {
  // A missing id must not become a `null` filter, which would match every unclaimed row.
  if (!isId(mentraUserId)) throw new Error("mentraUserId is required")
  const actor: Actor = {kind: "user", mentraUserId, email: null, emailVerified: false, isOrganizationAdmin: false}

  return withTransaction(async session => {
    const links = await IdentityLinkModel.find({mentraUserId}).select({_id: 0, provider: 1, subject: 1}).session(session).lean()
    const workosSubjects = links.filter(link => link.provider === "workos").map(link => link.subject)
    const memberships = await WorkspaceMembershipModel.find({
      status: "active",
      $or: [{mentraUserId}, ...(workosSubjects.length > 0 ? [{pendingWorkosUserId: {$in: workosSubjects}}] : [])],
    })
      .sort({workspaceId: 1, startedAt: 1, _id: 1})
      .session(session)
      .lean<MembershipRow[]>()

    if (links.length > 0) await IdentityLinkModel.deleteMany({mentraUserId}, {session})

    const byWorkspace = new Map<string, MembershipRow[]>()
    for (const membership of memberships) {
      const rows = byWorkspace.get(membership.workspaceId)
      if (rows) rows.push(membership)
      else byWorkspace.set(membership.workspaceId, [membership])
    }
    for (const [workspaceId, rows] of byWorkspace) {
      // Like every membership change, write the workspace first: it invalidates cached authorization
      // and conflicts with a concurrent change there. Not limited to active workspaces (workspace
      // documents are never deleted), so a stray active row in a deleted one still ends.
      const workspace = await WorkspaceModel.findOneAndUpdate(
        {workspaceId},
        {$inc: {authorizationRevision: 1}},
        {new: true, session},
      ).lean<WorkspaceRow>()
      if (!workspace) throw new Error(`membership ${rows[0]!.membershipId} names a workspace that does not exist`)
      for (const membership of rows) {
        await endMembership(session, {
          workspace,
          actor,
          membership,
          reason: "account_deleted",
          action: "membership.removed",
        })
      }
    }

    await recordWorkspaceEvent(session, {
      workspaceId: null,
      action: USER_DELETED_ACTION,
      actor: auditActor(actor),
      target: {mentraUserId},
    })
    return {endedMembershipIds: memberships.map(membership => membership.membershipId)}
  })
}
