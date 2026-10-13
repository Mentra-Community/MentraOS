/**
 * @fileoverview What deleting a Mentra account does to workspaces.
 *
 * One transaction, as the deleted user:
 *  - ends every active membership the user holds with `endedReason:
 *    "account_deleted"`. Each ends as removal does (`endMembership`): the
 *    workspace's revision is bumped, the credentials and pending invitations
 *    that membership created are revoked, and one `membership.removed` event is
 *    recorded;
 *  - revokes every other pending invitation the user sent, such as one sent as
 *    an Organization Admin (`invitation.revoked`, reason `inviter_account_deleted`);
 *  - records the `user.deleted` tombstone last: `workspaceId` null, target
 *    `{mentraUserId}`. It is on the change feed after the removals above, so a
 *    service holding data keyed by this person (Fleet) knows to delete it. It is
 *    recorded for everyone, including a person who belongs to no workspace, and
 *    once: a deletion that runs again finds it.
 * Then the operator keys the person created are revoked (a deleted account is no
 * Organization Admin), and the person's identity is cleared from what stays as
 * history: the email copied onto their membership rows, the creator's email and
 * user id on every credential they created, their address on keys a service
 * issued at their request, and the inviter's email and user id on every
 * invitation they sent. Nothing needs those after the deletion: the
 * credentials and invitations are revoked, and who did what stays in the audit
 * trail. Membership rows keep the opaque `mentraUserId`, which is what their
 * history is keyed by.
 *
 * Account deletion is never refused for a workspace's sake. A workspace whose
 * last owner this was is left without one, and an Organization Admin recovers it
 * (`recoverOwnership`, which refuses a deleted account).
 *
 * Invitations addressed to the user's email stay: they name an address, not an
 * account. Audit events keep the addresses they recorded, the actor's and the
 * member's or invitee's they name: the audit trail is the record of who did what.
 */

import {createLogger} from "@mentra/cloud-shared"
import {USER_DELETED_ACTION} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel, type AccessCredentialRow} from "../../models/access-credential.model"
import {WorkspaceAuditEventModel} from "../../models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {
  recordFeedEventWithoutTransaction,
  recordWorkspaceEvent,
  type WorkspaceAuditEventInput,
} from "./audit.service"
import {markRevoked} from "./credential.service"
import {revokeInvitationsSentBy} from "./invitation.service"
import {auditActor, endMembership, isId, type Actor, type MembershipRow} from "./workspace.service"

const logger = createLogger("core").child({service: "account-deletion"})

/**
 * End the deleted user's workspace memberships and revoke the invitations they sent (in one
 * transaction that ends with the `user.deleted` tombstone), revoke the operator keys they created
 * and clear their identity from the rows that stay. Safe to run again: a second run finds nothing
 * left to end or revoke, and the tombstone already recorded.
 */
export async function removeDeletedUserFromWorkspaces(mentraUserId: string): Promise<{
  endedMembershipIds: string[]
  revokedInvitationIds: string[]
  revokedOperatorKeyIds: string[]
}> {
  // A missing id must not become a `null` filter.
  if (!isId(mentraUserId)) throw new Error("mentraUserId is required")
  const actor: Actor = {kind: "user", mentraUserId, email: null, emailVerified: false, isOrganizationAdmin: false}
  // Most accounts belong to no workspace and sent no invitation: nothing to end for them, only the tombstone.
  const workspaceState = Boolean(
    (await WorkspaceMembershipModel.exists({status: "active", mentraUserId})) ||
      (await WorkspaceInvitationModel.exists({status: "pending", invitedByMentraUserId: mentraUserId})),
  )
  const tombstone: WorkspaceAuditEventInput = {
    workspaceId: null,
    action: USER_DELETED_ACTION,
    actor: auditActor(actor),
    target: {mentraUserId},
  }
  let endedMembershipIds: string[] = []
  let revokedInvitationIds: string[] = []
  // A repeat finds the tombstone and, with nothing left to end, does not even open a transaction.
  if (workspaceState || !(await tombstoneRecorded(mentraUserId, null))) {
    try {
      // The tombstone is the transaction's last write: the removals before it are on the feed before it.
      // Checked again inside, so two runs at once record it once.
      await withTransaction(async session => {
        endedMembershipIds = workspaceState ? await endMemberships(session, mentraUserId, actor) : []
        revokedInvitationIds = workspaceState
          ? await revokeInvitationsSentBy(session, mentraUserId, actor, "inviter_account_deleted")
          : []
        if (!(await tombstoneRecorded(mentraUserId, session))) await recordWorkspaceEvent(session, tombstone)
      })
    } catch (err) {
      // A database that cannot run a transaction (Azure Cosmos DB for MongoDB RU, a standalone mongod)
      // has no workspace state to end: workspace writes fail there. Deleting such an account must not
      // start failing, and its tombstone is still owed to the services that hold data about the person.
      if (workspaceState) throw err
      logger.warn({err, mentraUserId}, "could not record the user.deleted tombstone in a transaction; recording it without one")
      if (!(await tombstoneRecorded(mentraUserId, null))) await recordFeedEventWithoutTransaction(tombstone)
    }
  }

  // An operator key is one document: revoked one by one, without a transaction.
  const operatorKeys = await AccessCredentialModel.find({
    credentialKind: "organization",
    createdByMentraUserId: mentraUserId,
    revokedAt: null,
  }).lean<AccessCredentialRow[]>()
  for (const key of operatorKeys) await markRevoked(null, key, auditActor(actor))

  // Everything the person created or sent is revoked by now, so their identity can go. Clearing it
  // never makes anything valid again: a workspace key stands on its ended membership, and an operator
  // key with no creator email is on no allowlist. A key a service issued at the person's request
  // (a Store package key) stays the workspace's, but loses the address it recorded for them.
  const addresses = await recordedAddresses(mentraUserId)
  await AccessCredentialModel.updateMany(
    {createdByMentraUserId: mentraUserId},
    {$set: {createdByMentraUserId: null, createdByEmail: null}},
  )
  if (addresses.length > 0) {
    await AccessCredentialModel.updateMany(
      {issuedByService: {$ne: null}, createdByEmail: {$in: addresses}},
      {$set: {createdByEmail: null}},
    )
  }
  await WorkspaceInvitationModel.updateMany(
    {invitedByMentraUserId: mentraUserId},
    {$set: {invitedByMentraUserId: null, invitedByEmail: null}},
  )
  await WorkspaceMembershipModel.updateMany({mentraUserId, email: {$ne: null}}, {$set: {email: null}})
  return {endedMembershipIds, revokedInvitationIds, revokedOperatorKeyIds: operatorKeys.map(key => key.credentialId)}
}

/** Whether the change feed already carries this person's `user.deleted` tombstone. */
async function tombstoneRecorded(mentraUserId: string, session: ClientSession | null): Promise<boolean> {
  const found = WorkspaceAuditEventModel.exists({
    workspaceId: null,
    action: USER_DELETED_ACTION,
    "target.mentraUserId": mentraUserId,
  })
  return Boolean(await (session ? found.session(session) : found))
}

/**
 * The email addresses Core recorded for the person: copied onto their membership rows, and on the
 * credentials they created. Each as recorded and lowercased, for exact matching.
 */
async function recordedAddresses(mentraUserId: string): Promise<string[]> {
  const [memberships, credentials] = await Promise.all([
    WorkspaceMembershipModel.find({mentraUserId, email: {$ne: null}}).select({email: 1}).lean(),
    AccessCredentialModel.find({createdByMentraUserId: mentraUserId, createdByEmail: {$ne: null}})
      .select({createdByEmail: 1})
      .lean(),
  ])
  const addresses = new Set<string>()
  for (const recorded of [...memberships.map(row => row.email), ...credentials.map(row => row.createdByEmail)]) {
    const address = recorded?.trim()
    if (!address) continue
    addresses.add(address)
    addresses.add(address.toLowerCase())
  }
  return [...addresses]
}

/** End every active membership of the user, inside the caller's transaction. */
async function endMemberships(session: ClientSession, mentraUserId: string, actor: Actor): Promise<string[]> {
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
  return memberships.map(membership => membership.membershipId)
}
