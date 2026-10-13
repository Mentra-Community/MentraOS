/**
 * @fileoverview The membership claim: Store-imported memberships reach their person.
 *
 * Memberships imported from the Store wait under the Store's WorkOS user id
 * (`pendingWorkosUserId`, no `mentraUserId`). The operator's export records the
 * verified email of each such WorkOS user (`legacy_browser_identities`). A person
 * whose verified email is exactly that address claims the identity:
 *  - at every sign-in through Core's sign-in server (`claimLegacyIdentities`,
 *    registered by Core's startup to run after each one), and
 *  - at their first Core access token a Core process resolves
 *    (`claimLegacyIdentitiesOnce`, from `principalFromToken`: Core's API bearers
 *    and the Store's signed service API), checked at most once per ten minutes per
 *    person in a process.
 * The phone's token exchange never claims. An unverified email claims nothing; a
 * Private Cloud provider's email outside its verified domains is unverified.
 *
 * Claiming an identity, in one transaction for everything the person can claim:
 *  - marks it claimed (`claimedAt`, `claimedBy`); a claimed identity is never
 *    claimed by anyone else, so a second Core user with the same email gets nothing;
 *  - moves its pending memberships to the person (`claimPendingMemberships`). A
 *    pending membership in a workspace where the person already holds one merges
 *    into it: the kept membership takes the higher role, the imported one ends
 *    (`removed`), and its live keys and pending invitations move to the kept one
 *    (`repointCredentials`), so nothing the person could do is lost;
 *  - moves enterprise org ownership (`enterprise_orgs.ownerUserId`) from the
 *    WorkOS user id to the person.
 * Each move is audited (`membership.claimed`, `membership.merged_duplicate`, as
 * the system) and bumps its workspace's authorization revision once, as every
 * change to who holds a role does. Keys and invitations the claimed memberships
 * made are stamped with the person's user id, so deleting their account later
 * finds them.
 *
 * An identity its person already claimed is checked again at their later sign-ins:
 * a membership an import re-run adds under that WorkOS user goes to them.
 *
 * Most sign-ins have nothing to claim: one indexed read finds that out, and a
 * transaction is opened only when there is something to claim.
 */

import {createLogger} from "@mentra/cloud-shared"
import {roleAtLeast, WORKSPACE_ROLES, type WorkspaceRole} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel} from "../../models/access-credential.model"
import {EnterpriseOrgModel} from "../../models/enterprise-org.model"
import {LegacyBrowserIdentityModel} from "../../models/legacy-browser-identity.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"
import {isDeletedAccountId} from "../user.service"
import {recordWorkspaceEvent} from "./audit.service"
import {RecentChecks} from "./recent-checks"
import {isId, roleEntry, type MembershipRow} from "./workspace.service"

const logger = createLogger("core").child({service: "membership-claim"})

const SYSTEM_ACTOR = {kind: "system"} as const
/** How long the bearer path trusts its last check of a person, and how many people a process remembers. */
const RECHECK_AFTER_MS = 10 * 60_000
const MAX_REMEMBERED = 10_000

export interface ClaimInput {
  mentraUserId: string
  email: string | null
  emailVerified: boolean
}

// --- Claiming one WorkOS user's memberships -------------------------------

/**
 * Hand the active memberships pending under `workosUserId` to `mentraUserId`, inside the caller's
 * transaction. A pending membership in a workspace where the person already holds an active one is
 * merged into it (see the file header); any other is claimed in place. Returns how many of each.
 */
export async function claimPendingMemberships(
  session: ClientSession,
  workosUserId: string,
  mentraUserId: string,
): Promise<{claimed: number; merged: number}> {
  const result = {claimed: 0, merged: 0}
  if (!isId(workosUserId) || !isId(mentraUserId)) return result
  // Highest role first: if one person has two pending memberships in a workspace, the higher one is
  // claimed and the other merges into it.
  const pending = (
    await WorkspaceMembershipModel.find({pendingWorkosUserId: workosUserId, status: "active"})
      .session(session)
      .lean<MembershipRow[]>()
  ).sort(
    (a, b) =>
      rank(b.role) - rank(a.role) ||
      a.startedAt.getTime() - b.startedAt.getTime() ||
      (a.membershipId < b.membershipId ? -1 : 1),
  )
  if (pending.length === 0) return result

  const held = await WorkspaceMembershipModel.find({
    mentraUserId,
    status: "active",
    workspaceId: {$in: [...new Set(pending.map(row => row.workspaceId))]},
  })
    .session(session)
    .lean<MembershipRow[]>()
  const heldByWorkspace = new Map(held.map(row => [row.workspaceId, row]))
  const bumped = new Map<string, WorkspaceRow | null>()
  const now = new Date()

  for (const row of pending) {
    // Every change to who holds a role writes the workspace document first, once per workspace: it
    // invalidates cached authorization and serializes this claim with any other change there.
    if (!bumped.has(row.workspaceId)) bumped.set(row.workspaceId, await bumpWorkspace(session, row.workspaceId))
    const revision = bumped.get(row.workspaceId)?.authorizationRevision ?? 0
    const kept = heldByWorkspace.get(row.workspaceId)
    if (kept) {
      if (await mergeDuplicate(session, {duplicate: row, kept, workosUserId, mentraUserId, revision, now})) {
        result.merged += 1
        if (roleAtLeast(row.role as WorkspaceRole, kept.role as WorkspaceRole)) {
          heldByWorkspace.set(row.workspaceId, {...kept, role: row.role})
        }
      }
      continue
    }

    const claimed = await WorkspaceMembershipModel.updateOne(
      {membershipId: row.membershipId, pendingWorkosUserId: workosUserId, status: "active"},
      {$set: {mentraUserId, pendingWorkosUserId: null}},
      {session},
    )
    if (claimed.modifiedCount !== 1) continue
    result.claimed += 1
    heldByWorkspace.set(row.workspaceId, {...row, mentraUserId, pendingWorkosUserId: null})
    await stampCreator(session, row, mentraUserId)
    await recordWorkspaceEvent(session, {
      workspaceId: row.workspaceId,
      action: "membership.claimed",
      actor: SYSTEM_ACTOR,
      target: {membershipId: row.membershipId, mentraUserId, email: row.email ?? null},
      before: {mentraUserId: null},
      after: {mentraUserId, role: row.role},
    })
  }
  return result
}

/**
 * Merge the pending `duplicate` into the membership the person already holds in that workspace:
 * raise the kept one to the duplicate's role when that is higher, end the duplicate, move its live
 * keys and pending invitations to the kept one, and audit `membership.merged_duplicate`. False when
 * the duplicate was no longer pending.
 */
async function mergeDuplicate(
  session: ClientSession,
  args: {
    duplicate: MembershipRow
    kept: MembershipRow
    workosUserId: string
    mentraUserId: string
    revision: number
    now: Date
  },
): Promise<boolean> {
  const {duplicate, kept, workosUserId, mentraUserId, revision, now} = args
  const ended = await WorkspaceMembershipModel.updateOne(
    {membershipId: duplicate.membershipId, pendingWorkosUserId: workosUserId, status: "active"},
    {$set: {status: "ended", endedAt: now, endedReason: "removed"}},
    {session},
  )
  if (ended.modifiedCount !== 1) return false

  const pendingRole = duplicate.role as WorkspaceRole
  const keptRole = kept.role as WorkspaceRole
  // Merging never takes access away, and a workspace never loses its owner to it.
  const raised = pendingRole !== keptRole && roleAtLeast(pendingRole, keptRole)
  if (raised) {
    await WorkspaceMembershipModel.updateOne(
      {membershipId: kept.membershipId, status: "active"},
      {$set: {role: pendingRole}, $push: {roleHistory: roleEntry(pendingRole, now, revision)}},
      {session},
    )
  }
  await stampCreator(session, duplicate, mentraUserId)
  const repointedCredentialIds = await repointCredentials(session, duplicate, kept.membershipId)
  const repointedInvitationIds = await repointInvitations(session, duplicate, kept.membershipId)
  await recordWorkspaceEvent(session, {
    workspaceId: duplicate.workspaceId,
    action: "membership.merged_duplicate",
    actor: SYSTEM_ACTOR,
    target: {membershipId: duplicate.membershipId, mentraUserId, email: duplicate.email ?? null},
    before: {role: pendingRole, status: "active", keptMembershipId: kept.membershipId, keptRole},
    after: {
      status: "ended",
      endedReason: "removed",
      keptMembershipId: kept.membershipId,
      resultingRole: raised ? pendingRole : keptRole,
      repointedCredentialIds,
      repointedInvitationIds,
    },
  })
  return true
}

/**
 * Move the live credentials an ended duplicate created to the membership that survived the merge,
 * returning their ids. A workspace key is only valid while its creator's membership is active, so
 * without this an imported key would stop working the moment its creator claimed a second membership
 * in a workspace they already belonged to. Revoked keys stay with the duplicate, as history.
 */
export async function repointCredentials(
  session: ClientSession,
  duplicate: {membershipId: string; workspaceId: string},
  keptMembershipId: string,
): Promise<string[]> {
  const credentials = await AccessCredentialModel.find({
    workspaceId: duplicate.workspaceId,
    createdByMembershipId: duplicate.membershipId,
    revokedAt: null,
  })
    .select({_id: 0, credentialId: 1})
    .session(session)
    .lean()
  const credentialIds = credentials.map(credential => credential.credentialId).sort()
  if (credentialIds.length > 0) {
    await AccessCredentialModel.updateMany(
      {credentialId: {$in: credentialIds}, revokedAt: null},
      {$set: {createdByMembershipId: keptMembershipId}},
      {session},
    )
  }
  return credentialIds
}

/** Move the pending invitations an ended duplicate sent to the surviving membership, returning their ids. */
export async function repointInvitations(
  session: ClientSession,
  duplicate: {membershipId: string; workspaceId: string},
  keptMembershipId: string,
): Promise<string[]> {
  const invitations = await WorkspaceInvitationModel.find({
    workspaceId: duplicate.workspaceId,
    invitedByMembershipId: duplicate.membershipId,
    status: "pending",
  })
    .select({_id: 0, invitationId: 1})
    .session(session)
    .lean()
  const invitationIds = invitations.map(invitation => invitation.invitationId).sort()
  if (invitationIds.length > 0) {
    await WorkspaceInvitationModel.updateMany(
      {invitationId: {$in: invitationIds}, status: "pending"},
      {$set: {invitedByMembershipId: keptMembershipId}},
      {session},
    )
  }
  return invitationIds
}

/**
 * Record the person on the keys and invitations an imported membership made, which carry no Core
 * user until it is claimed: account deletion finds a person's keys and invitations by it.
 */
async function stampCreator(session: ClientSession, membership: MembershipRow, mentraUserId: string): Promise<void> {
  await AccessCredentialModel.updateMany(
    {workspaceId: membership.workspaceId, createdByMembershipId: membership.membershipId, createdByMentraUserId: null},
    {$set: {createdByMentraUserId: mentraUserId}},
    {session},
  )
  await WorkspaceInvitationModel.updateMany(
    {workspaceId: membership.workspaceId, invitedByMembershipId: membership.membershipId, invitedByMentraUserId: null},
    {$set: {invitedByMentraUserId: mentraUserId}},
    {session},
  )
}

/** Bump an active workspace's authorization revision; null for a workspace that is gone or deleted. */
async function bumpWorkspace(session: ClientSession, workspaceId: string): Promise<WorkspaceRow | null> {
  return WorkspaceModel.findOneAndUpdate(
    {workspaceId, status: "active"},
    {$inc: {authorizationRevision: 1}},
    {new: true, session},
  ).lean<WorkspaceRow>()
}

function rank(role: string): number {
  return (WORKSPACE_ROLES as readonly string[]).indexOf(role)
}

// --- Claiming legacy identities --------------------------------------------

/**
 * Claim, for the person, every unclaimed legacy identity with exactly their verified email (and pick
 * up anything new under identities they claimed before), in one transaction. A no-op unless the
 * email is verified. Returns how many identities this call claimed.
 */
export async function claimLegacyIdentities(input: ClaimInput): Promise<{claimedIdentities: number}> {
  const none = {claimedIdentities: 0}
  const mentraUserId = input?.mentraUserId
  const email = normalizeEmail(input?.email)
  if (input?.emailVerified !== true || !isId(mentraUserId) || !email) return none

  const claimable = {$or: [{email, claimedAt: null}, {claimedBy: mentraUserId}]}
  // The cheap, indexed check that keeps an ordinary sign-in free of transactions.
  const candidates = await LegacyBrowserIdentityModel.find(claimable)
    .select({_id: 0, workosUserId: 1, claimedAt: 1})
    .lean()
  if (candidates.length === 0) return none
  if (candidates.every(candidate => candidate.claimedAt)) {
    const waiting = await WorkspaceMembershipModel.exists({
      pendingWorkosUserId: {$in: candidates.map(candidate => candidate.workosUserId)},
      status: "active",
    })
    if (!waiting) return none
  }

  return withTransaction(async session => {
    // A deleted account is no principal; should one reach here it claims nothing.
    if (await isDeletedAccountId(mentraUserId, session)) return none
    const identities = await LegacyBrowserIdentityModel.find(claimable)
      .select({_id: 0, workosUserId: 1, claimedAt: 1, claimedBy: 1})
      .sort({workosUserId: 1})
      .session(session)
      .lean()
    let claimedIdentities = 0
    const moved = {claimed: 0, merged: 0, enterpriseOrgs: 0}
    for (const identity of identities) {
      const {workosUserId} = identity
      if (!identity.claimedAt) {
        const marked = await LegacyBrowserIdentityModel.updateOne(
          {workosUserId, claimedAt: null},
          {$set: {claimedAt: new Date(), claimedBy: mentraUserId}},
          {session},
        )
        if (marked.modifiedCount !== 1) continue
        claimedIdentities += 1
      } else if (identity.claimedBy !== mentraUserId) {
        continue
      }
      const memberships = await claimPendingMemberships(session, workosUserId, mentraUserId)
      moved.claimed += memberships.claimed
      moved.merged += memberships.merged
      const owned = await EnterpriseOrgModel.updateMany(
        {ownerUserId: workosUserId},
        {$set: {ownerUserId: mentraUserId}},
        {session},
      )
      moved.enterpriseOrgs += owned.modifiedCount
    }
    if (claimedIdentities + moved.claimed + moved.merged + moved.enterpriseOrgs > 0) {
      logger.info({mentraUserId, claimedIdentities, ...moved}, "claimed Store-imported access")
    }
    return {claimedIdentities}
  })
}

const recentChecks = new RecentChecks(RECHECK_AFTER_MS, MAX_REMEMBERED)

/**
 * The claim on the bearer path: skipped when this Core process checked the same person in the last
 * ten minutes (it remembers at most 10,000 people). A failure is logged and never fails the request;
 * the next request checks again.
 */
export async function claimLegacyIdentitiesOnce(input: ClaimInput): Promise<void> {
  if (input?.emailVerified !== true || !isId(input.mentraUserId) || !normalizeEmail(input.email)) return
  if (!recentChecks.begin(input.mentraUserId)) return
  try {
    await claimLegacyIdentities(input)
  } catch (err) {
    recentChecks.forget(input.mentraUserId)
    logger.error(
      {mentraUserId: input.mentraUserId, errorName: (err as Error)?.name, error: (err as Error)?.message},
      "could not claim Store-imported memberships",
    )
  }
}

/** The claim after a sign-in at Core's sign-in server: Core's startup registers it (`registerAfterSignInHook`). */
export async function claimLegacyIdentitiesAfterSignIn(identity: ClaimInput): Promise<void> {
  await claimLegacyIdentities({
    mentraUserId: identity.mentraUserId,
    email: identity.email,
    emailVerified: identity.emailVerified,
  })
}

/** Forget which people this process checked (tests). */
export function resetLegacyIdentityClaimChecks(): void {
  recentChecks.clear()
}

function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : ""
}
