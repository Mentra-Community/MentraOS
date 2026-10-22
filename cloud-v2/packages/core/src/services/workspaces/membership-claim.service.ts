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
 *    person in a process; a request arriving while that check runs waits for it.
 * The phone's token exchange never claims. An unverified email claims nothing; a
 * Private Cloud provider's email outside its verified domains is unverified.
 *
 * Claiming an identity, in one transaction for everything the person can claim:
 *  - marks it claimed (`claimedAt`, `claimedBy`); a claimed identity is never
 *    claimed by anyone else, so a second Core user with the same email gets nothing;
 *  - gives the person one workspace from the memberships pending under all of
 *    their identities (`claimPendingMemberships`). A pending membership in a
 *    workspace where the person already holds one merges into it: the kept
 *    membership takes the higher role, the imported one ends (`removed`), and its
 *    live keys and pending invitations move to the kept one (`repointCredentials`),
 *    so nothing the person could do is lost. A person in no workspace takes the one
 *    the import's rule picks (highest role, earliest among equals). Every other
 *    pending membership is discarded (`membership.removed`, its keys and
 *    invitations revoked), so nothing is left to claim later; a discarded last
 *    Owner is replaced by the workspace's next member, and a workspace left with
 *    nobody to promote is logged for an Organization Admin to recover;
 *  - moves enterprise org ownership (`enterprise_orgs.ownerUserId`) from the
 *    WorkOS user id to the person.
 * Each move is audited (`membership.claimed`, `membership.merged_duplicate`,
 * `membership.removed`, `membership.role_changed`, as the system) and bumps its
 * workspace's authorization revision once, as every change to who holds a role does. Keys and invitations the claimed memberships
 * made are stamped with the person's user id, so deleting their account later
 * finds them.
 *
 * An identity its person already claimed is checked again at their later sign-ins:
 * a membership an import re-run adds under that WorkOS user, or an enterprise org
 * still owned by it, goes to them.
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
import {insertGuard} from "./membership-guard.service"
import {RecentChecks} from "./recent-checks"
import {countActiveOwners, endMembership, isId, roleEntry, type MembershipRow} from "./workspace.service"

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

// --- Claiming the memberships waiting under a person's WorkOS users -----------

/** What one claim did to the pending memberships it found. */
export interface ClaimedMemberships {
  claimed: number
  merged: number
  discarded: number
  /** Workspaces a discarded last Owner left with no Owner and nobody to promote, for an Organization Admin. */
  ownerless: string[]
}

/** The import's pick: highest role, then the earliest join, then the smallest membership id. */
function pickOrder(a: MembershipRow, b: MembershipRow): number {
  return (
    rank(b.role) - rank(a.role) ||
    a.startedAt.getTime() - b.startedAt.getTime() ||
    (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0)
  )
}

/**
 * Hand the active memberships pending under `workosUserIds` (every WorkOS user the person claims) to
 * `mentraUserId`, inside the caller's transaction, keeping one workspace per person:
 *  - a pending membership in a workspace where the person already holds an active one merges into it;
 *  - when the person holds none, the one the import's rule picks (`pickOrder`) is claimed in place, and the
 *    others in that workspace merge into it;
 *  - every other one is discarded: ended (`removed`, `membership.removed` as the system) with its keys and
 *    invitations revoked, so nothing is left to claim later. A discarded last Owner is replaced by the
 *    workspace's next member (`promoteNextOwner`); with nobody to promote the workspace is reported as
 *    ownerless, for an Organization Admin to recover.
 */
export async function claimPendingMemberships(
  session: ClientSession,
  workosUserIds: string[],
  mentraUserId: string,
): Promise<ClaimedMemberships> {
  const result: ClaimedMemberships = {claimed: 0, merged: 0, discarded: 0, ownerless: []}
  const ids = workosUserIds.filter(isId)
  if (ids.length === 0 || !isId(mentraUserId)) return result
  const pending = (
    await WorkspaceMembershipModel.find({pendingWorkosUserId: {$in: ids}, status: "active"})
      .session(session)
      .lean<MembershipRow[]>()
  ).sort(pickOrder)
  if (pending.length === 0) return result

  const held = await WorkspaceMembershipModel.find({mentraUserId, status: "active"}).session(session).lean<MembershipRow[]>()
  const heldByWorkspace = new Map(held.map(row => [row.workspaceId, row]))
  const bumped = new Map<string, WorkspaceRow | null>()
  const now = new Date()

  for (const row of pending) {
    const workosUserId = row.pendingWorkosUserId as string
    // Every change to who holds a role writes the workspace document first, once per workspace: it
    // invalidates cached authorization and serializes this claim with any other change there.
    if (!bumped.has(row.workspaceId)) bumped.set(row.workspaceId, await bumpWorkspace(session, row.workspaceId))
    const workspace = bumped.get(row.workspaceId) ?? null
    const revision = workspace?.authorizationRevision ?? 0
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

    // One workspace per person: once they hold one, every other pending membership is discarded.
    if (heldByWorkspace.size > 0) {
      if (!workspace) continue
      await endMembership(session, {workspace, actor: SYSTEM_ACTOR, membership: row, reason: "removed", action: "membership.removed"})
      result.discarded += 1
      if (row.role === "owner" && (await countActiveOwners(row.workspaceId, session)) === 0) {
        if (!(await promoteNextOwner(session, row.workspaceId, revision, now))) {
          result.ownerless.push(row.workspaceId)
          logger.warn(
            {workspaceId: row.workspaceId, membershipId: row.membershipId},
            "a discarded imported Owner left the workspace with no Owner; an Organization Admin must recover it",
          )
        }
      }
      continue
    }

    const claimed = await WorkspaceMembershipModel.updateOne(
      {membershipId: row.membershipId, pendingWorkosUserId: workosUserId, status: "active"},
      {$set: {mentraUserId, pendingWorkosUserId: null, claimedAt: now}},
      {session},
    )
    if (claimed.modifiedCount !== 1) continue
    await insertGuard(session, mentraUserId, {workspaceId: row.workspaceId, membershipId: row.membershipId})
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
 * Make the workspace's next member its Owner, as the duplicate-membership cleanup does: an account that exists,
 * highest role, earliest joined (`membership.role_changed`, as the system). False when there is nobody to promote.
 */
async function promoteNextOwner(session: ClientSession, workspaceId: string, revision: number, now: Date): Promise<boolean> {
  const members = await WorkspaceMembershipModel.find({workspaceId, status: "active", mentraUserId: {$type: "string"}})
    .session(session)
    .lean<MembershipRow[]>()
  const candidates: MembershipRow[] = []
  for (const row of members) {
    if (!(await isDeletedAccountId(row.mentraUserId as string, session))) candidates.push(row)
  }
  const [next] = candidates.sort(pickOrder)
  if (!next) return false
  await WorkspaceMembershipModel.updateOne(
    {membershipId: next.membershipId, status: "active"},
    {$set: {role: "owner"}, $push: {roleHistory: roleEntry("owner", now, revision)}},
    {session},
  )
  await recordWorkspaceEvent(session, {
    workspaceId,
    action: "membership.role_changed",
    actor: SYSTEM_ACTOR,
    target: {membershipId: next.membershipId, mentraUserId: next.mentraUserId ?? null, email: next.email ?? null},
    before: {role: next.role},
    after: {role: "owner"},
  })
  return true
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
    // Everything was claimed before: anything new under these ids (a re-run's membership, an
    // enterprise org) still goes to the person.
    const workosUserIds = candidates.map(candidate => candidate.workosUserId)
    const waiting =
      (await WorkspaceMembershipModel.exists({pendingWorkosUserId: {$in: workosUserIds}, status: "active"})) ||
      (await EnterpriseOrgModel.exists({ownerUserId: {$in: workosUserIds}}))
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
    let enterpriseOrgs = 0
    const mine: string[] = []
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
      mine.push(workosUserId)
      const owned = await EnterpriseOrgModel.updateMany(
        {ownerUserId: workosUserId},
        {$set: {ownerUserId: mentraUserId}},
        {session},
      )
      enterpriseOrgs += owned.modifiedCount
    }
    // One pick across every identity with the email, so the person's one membership is the best of them all.
    const {ownerless, ...moved} = await claimPendingMemberships(session, mine, mentraUserId)
    if (claimedIdentities + moved.claimed + moved.merged + moved.discarded + enterpriseOrgs > 0) {
      logger.info(
        {mentraUserId, claimedIdentities, ...moved, ...(ownerless.length > 0 ? {ownerless} : {}), enterpriseOrgs},
        "claimed Store-imported access",
      )
    }
    return {claimedIdentities}
  })
}

const recentChecks = new RecentChecks(RECHECK_AFTER_MS, MAX_REMEMBERED)
/** Bearer-path checks running now, by person. */
const inFlightChecks = new Map<string, Promise<void>>()

/**
 * The claim on the bearer path: skipped when this Core process checked the same person in the last
 * ten minutes (it remembers at most 10,000 people). A failure is logged and never fails the request;
 * the next request checks again.
 */
export async function claimLegacyIdentitiesOnce(input: ClaimInput): Promise<void> {
  if (input?.emailVerified !== true || !isId(input.mentraUserId) || !normalizeEmail(input.email)) return
  const mentraUserId = input.mentraUserId
  // A request arriving while another one's check runs waits for it, so it sees what that one claims.
  const running = inFlightChecks.get(mentraUserId)
  if (running) return running
  if (!recentChecks.begin(mentraUserId)) return
  const check = (async () => {
    try {
      await claimLegacyIdentities(input)
    } catch (err) {
      recentChecks.forget(mentraUserId)
      logger.error(
        {mentraUserId, errorName: (err as Error)?.name, error: (err as Error)?.message},
        "could not claim Store-imported memberships",
      )
    } finally {
      inFlightChecks.delete(mentraUserId)
    }
  })()
  inFlightChecks.set(mentraUserId, check)
  return check
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
