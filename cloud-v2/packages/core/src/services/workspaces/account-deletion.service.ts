/**
 * @fileoverview What deleting a Mentra account does to workspaces.
 *
 * One transaction, as the deleted user, ends every active membership the user
 * holds with `endedReason: "account_deleted"`. Each ends as removal does
 * (`endMembership`): the workspace's revision is bumped, the credentials that
 * membership created are revoked, and one `membership.removed` event is recorded.
 *
 * Account deletion is never refused for a workspace's sake. A workspace whose
 * last owner this was is left without one, and an Organization Admin recovers it
 * (`recoverOwnership`).
 *
 * Pending invitations the user sent stay valid: an invitation does not depend on
 * its inviter's membership (accepting checks the invitation, the workspace and
 * the invitee only), which is also what removing an inviter does. Invitations
 * addressed to the user's email stay too: they name an address, not an account.
 *
 * Operator keys the user created are not revoked here: an operator key works
 * only while its creator's email is on the Organization Admin allowlist, and the
 * allowlist, not the account, decides that.
 */

import {withTransaction} from "../../connections/mongo.connection"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {endMembership, isId, type Actor, type MembershipRow} from "./workspace.service"

/**
 * End the deleted user's workspace memberships, in one transaction. Safe to run
 * again: a second run finds nothing left to end.
 */
export async function removeDeletedUserFromWorkspaces(mentraUserId: string): Promise<{endedMembershipIds: string[]}> {
  // A missing id must not become a `null` filter.
  if (!isId(mentraUserId)) throw new Error("mentraUserId is required")
  const actor: Actor = {kind: "user", mentraUserId, email: null, emailVerified: false, isOrganizationAdmin: false}
  // Most accounts belong to no workspace; they need no transaction (nor a replica set).
  if (!(await WorkspaceMembershipModel.exists({status: "active", mentraUserId}))) return {endedMembershipIds: []}

  return withTransaction(async session => {
    const memberships = await WorkspaceMembershipModel.find({status: "active", mentraUserId})
      .sort({workspaceId: 1, startedAt: 1, _id: 1})
      .session(session)
      .lean<MembershipRow[]>()

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
    return {endedMembershipIds: memberships.map(membership => membership.membershipId)}
  })
}
