/**
 * @fileoverview WorkOS user -> `mentraUserId`.
 *
 * A WorkOS user is linked to a Mentra user exactly once, on first sight, and
 * the link is never recomputed. A later sign-in with the same WorkOS user
 * returns the linked id even if the person has since created a Mentra account
 * with the same email: moving them then would silently change who their
 * memberships belong to.
 *
 * First sight picks the user in this order:
 *  1. the WorkOS email is verified and a Mentra (GoTrue) account whose email
 *     itself is confirmed (`email_confirmed_at`, not a phone confirmation) exists:
 *     use that account's user (`linkedVia: verified_email`);
 *  2. otherwise a user in the `workos` tenant keyed by the WorkOS user id
 *     (`linkedVia: workos_tenant`).
 *
 * Memberships migrated under a WorkOS user id (`pendingWorkosUserId`) are
 * claimed for the linked user right after the link is written and again on any
 * later sign-in that still finds one, so a migration that lands after the person
 * has already signed in is not stranded. The link itself is a single-document
 * write, and a claim opens a transaction only when there is something pending:
 * a sign-in with nothing to claim never needs a multi-collection transaction. A
 * claim that fails after the link was written is retried by the next sign-in.
 * Every claim is recorded as a `membership.claimed` audit event.
 */

import {createLogger} from "@mentra/cloud-shared"
import {roleAtLeast, type WorkspaceRole} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {AccessCredentialModel} from "../../models/access-credential.model"
import {IdentityLinkModel, type IdentityLinkMethod} from "../../models/identity-link.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {findUserByEmail, isGotrueAdminConfigured} from "../account/gotrue.client"
import {isWorkosConfigured} from "../developer-auth.service"
import {findOrCreateUser} from "../user.service"
import {recordWorkspaceEvent} from "./audit.service"
import {isDeployedEnvironment} from "./organization"
import {roleEntry} from "./workspace.service"

const logger = createLogger("core").child({service: "identity-link.service"})

const PROVIDER = "workos"

/**
 * Warn, once at boot, about a deployed Core that signs people in with WorkOS but has no GoTrue admin
 * credentials (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`). Without them there is no Mentra
 * directory to match, so every first WorkOS sign-in is linked to a separate `workos`-tenant identity
 * and the person is not the Mentra user their phone and the Store know, for good: the link is never
 * recomputed. That is right for a private deployment with no Mentra accounts, and a mistake anywhere
 * else, so it is said out loud rather than found later. Returns whether it warned.
 */
export function warnIfWorkosIdentitiesStaySeparate(log: Pick<typeof logger, "warn"> = logger): boolean {
  if (!isDeployedEnvironment() || isGotrueAdminConfigured() || !isWorkosConfigured()) return false
  log.warn(
    {environment: process.env.CLOUD_CORE_ENVIRONMENT ?? null},
    "WorkOS sign-in is configured but GoTrue admin is not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY): " +
      "WorkOS sign-ins will link to separate workos-tenant identities " +
      "instead of matching Mentra accounts by verified email",
  )
  return true
}

export interface WorkosIdentity {
  workosUserId: string
  email: string | null
  /**
   * Whether WorkOS verified `email`; `null` when that could not be determined (the profile lookup
   * failed), which is not the same as unverified. A first sign-in with `null` is refused, because the
   * link it would create is permanent (see {@link IdentityUnavailableError}).
   */
  emailVerified: boolean | null
  name: string | null
}

/**
 * The identity provider could not say enough to link a first sign-in safely. Nothing was written, and
 * signing in again once WorkOS answers works. Callers map it to a retryable failure (HTTP 503).
 */
export class IdentityUnavailableError extends Error {
  constructor(message = "the identity provider could not verify this sign-in; try again shortly") {
    super(message)
    this.name = "IdentityUnavailableError"
  }
}

/**
 * Resolve a WorkOS user to its Mentra user, linking on first sight.
 *
 * Safe to call concurrently for the same WorkOS user: one link row is written
 * and every caller gets the same `mentraUserId`.
 */
export async function resolveWorkosUser(identity: WorkosIdentity): Promise<{mentraUserId: string}> {
  const subject = identity.workosUserId
  if (typeof subject !== "string" || !subject.trim()) throw new Error("workosUserId is required")
  const email = identity.email?.trim() || null

  const existing = await IdentityLinkModel.findOne({provider: PROVIDER, subject}).lean()
  if (existing) {
    await refreshDisplayEmail(existing._id, existing.email ?? null, email)
    await claimPendingIfAny(subject, existing.mentraUserId)
    return {mentraUserId: existing.mentraUserId}
  }

  const {mentraUserId, linkedVia} = await chooseMentraUser(subject, email, identity.emailVerified)
  try {
    await IdentityLinkModel.create({provider: PROVIDER, subject, mentraUserId, email, linkedVia})
  } catch (err) {
    // A concurrent first login linked this WorkOS user first: its link stands, so resolve to the winner.
    // The winner normally claims too, but this resolution must not depend on that, so claim for the
    // winner's user here as well (a no-op once nothing is pending).
    if (!isDuplicateKeyError(err)) throw err
    const winner = await IdentityLinkModel.findOne({provider: PROVIDER, subject}).lean()
    if (!winner) throw err
    await claimPendingIfAny(subject, winner.mentraUserId)
    return {mentraUserId: winner.mentraUserId}
  }
  logger.info({mentraUserId, linkedVia}, "linked WorkOS identity to Mentra user")
  await claimPendingIfAny(subject, mentraUserId)
  return {mentraUserId}
}

async function chooseMentraUser(
  subject: string,
  email: string | null,
  emailVerified: boolean | null,
): Promise<{mentraUserId: string; linkedVia: IdentityLinkMethod}> {
  // Unknown verification is not "unverified". Where a directory could match this person, linking to the
  // workos tenant on a guess would separate them from their Mentra account for good, so ask them to
  // retry. Without a directory there is nothing to match, and the answer would not change.
  if (emailVerified === null && isGotrueAdminConfigured()) throw new IdentityUnavailableError()
  // Only a verified email may claim an existing account. An unverified address
  // proves nothing, so it never reaches GoTrue. A deployment with no GoTrue
  // admin credentials has no Mentra accounts to match, so it skips the lookup.
  // The link is permanent, so a configured directory that is erroring must fail
  // this sign-in (strict) rather than read as "no Mentra account" and link the
  // person to a separate workos-tenant user.
  if (emailVerified === true && email && isGotrueAdminConfigured()) {
    const account = await findUserByEmail(email, {strict: true})
    // The email itself must be confirmed: `confirmed_at` alone may come from a phone, and the link is permanent.
    if (account?.emailConfirmed) {
      const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: account.id})
      return {mentraUserId: user.mentraUserId, linkedVia: "verified_email"}
    }
  }
  const user = await findOrCreateUser({tenantId: "workos", tenantUserId: subject})
  return {mentraUserId: user.mentraUserId, linkedVia: "workos_tenant"}
}

/** The stored email is display-only, so a failed refresh never blocks sign-in. */
async function refreshDisplayEmail(linkId: unknown, stored: string | null, current: string | null): Promise<void> {
  if (!current || current === stored) return
  try {
    await IdentityLinkModel.updateOne({_id: linkId}, {$set: {email: current}})
  } catch (err) {
    logger.warn({err}, "could not refresh identity link display email")
  }
}

/**
 * Claim in its own transaction when this WorkOS user still has pending migrated
 * memberships. One indexed read gates it, so the common sign-in (nothing
 * pending) does not open a transaction. The claim re-reads inside the
 * transaction, so concurrent callers claim each row exactly once.
 */
async function claimPendingIfAny(workosUserId: string, mentraUserId: string): Promise<void> {
  const pending = await WorkspaceMembershipModel.exists({pendingWorkosUserId: workosUserId, status: "active"})
  if (!pending) return
  await withTransaction(session => claimPendingMemberships(session, workosUserId, mentraUserId))
}

/**
 * Hand memberships migrated under `pendingWorkosUserId` to the linked user,
 * recording `membership.claimed` for each row claimed. A pending row in a
 * workspace where the user already has an active membership
 * would break the one-active-membership rule, so it is ended (`removed`) and
 * audited instead and the membership the user already held survives. If the
 * pending row carried the higher role, the surviving row is raised to it, so
 * merging never takes access away (and a workspace never loses its owner).
 * Credentials the ended row created are repointed to the surviving row in the
 * same transaction: a credential is only valid while its creator's membership is
 * active, so without this a migrated key would die the moment its creator signed
 * in with a second membership already in hand.
 */
async function claimPendingMemberships(
  session: ClientSession,
  workosUserId: string,
  mentraUserId: string,
): Promise<void> {
  const pending = await WorkspaceMembershipModel.find({pendingWorkosUserId: workosUserId, status: "active"})
    .session(session)
    .lean()
  if (pending.length === 0) return

  const held = await WorkspaceMembershipModel.find({
    mentraUserId,
    status: "active",
    workspaceId: {$in: pending.map(row => row.workspaceId)},
  })
    .session(session)
    .lean()
  const heldByWorkspace = new Map(held.map(row => [row.workspaceId, row]))

  const now = new Date()
  for (const duplicate of pending) {
    const kept = heldByWorkspace.get(duplicate.workspaceId)
    if (!kept) continue
    const pendingRole = duplicate.role as WorkspaceRole
    const keptRole = kept.role as WorkspaceRole
    const raised = pendingRole !== keptRole && roleAtLeast(pendingRole, keptRole)
    const resultingRole = raised ? pendingRole : keptRole
    // Ending a row can lower the workspace's owner count, and a role change can alter what the member
    // may do. Either way the workspace document is written, first, like every workspace mutation: that
    // invalidates cached authorization and makes this write conflict with a concurrent leave or remove
    // that counts owners, so the last-owner guard cannot be raced past.
    const workspace = await WorkspaceModel.findOneAndUpdate(
      {workspaceId: duplicate.workspaceId},
      {$inc: {authorizationRevision: 1}},
      {new: true, session},
    ).lean()
    if (raised) {
      await WorkspaceMembershipModel.updateOne(
        {membershipId: kept.membershipId, status: "active"},
        {
          $set: {role: pendingRole},
          $push: {roleHistory: roleEntry(pendingRole, now, workspace?.authorizationRevision ?? 0)},
        },
        {session},
      )
    }
    await WorkspaceMembershipModel.updateOne(
      {membershipId: duplicate.membershipId, status: "active"},
      {$set: {status: "ended", endedAt: now, endedReason: "removed"}},
      {session},
    )
    const repointedCredentialIds = await repointCredentials(session, duplicate, kept.membershipId)
    await recordWorkspaceEvent(session, {
      workspaceId: duplicate.workspaceId,
      action: "membership.merged_duplicate",
      actor: {kind: "system"},
      target: {membershipId: duplicate.membershipId, mentraUserId},
      before: {
        membershipId: duplicate.membershipId,
        role: pendingRole,
        status: "active",
        pendingWorkosUserId: workosUserId,
        keptMembershipId: kept.membershipId,
        keptRole,
      },
      after: {
        membershipId: duplicate.membershipId,
        status: "ended",
        endedReason: "removed",
        keptMembershipId: kept.membershipId,
        resultingRole,
        repointedCredentialIds,
      },
    })
  }

  // Everything still pending belongs to this user now.
  for (const row of pending) {
    if (heldByWorkspace.has(row.workspaceId)) continue
    const claimed = await WorkspaceMembershipModel.updateOne(
      {membershipId: row.membershipId, pendingWorkosUserId: workosUserId, status: "active"},
      {$set: {mentraUserId, pendingWorkosUserId: null}},
      {session},
    )
    if (claimed.modifiedCount !== 1) continue
    await recordWorkspaceEvent(session, {
      workspaceId: row.workspaceId,
      action: "membership.claimed",
      actor: {kind: "system"},
      target: {membershipId: row.membershipId, mentraUserId},
      before: {pendingWorkosUserId: workosUserId},
      after: {mentraUserId, role: row.role},
    })
  }
}

/**
 * Move the live credentials created by an ended duplicate to the membership that
 * survived the merge, returning their ids. Revoked ones stay as history.
 */
async function repointCredentials(
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
  const credentialIds = credentials.map(credential => credential.credentialId)
  if (credentialIds.length > 0) {
    await AccessCredentialModel.updateMany(
      {credentialId: {$in: credentialIds}},
      {$set: {createdByMembershipId: keptMembershipId}},
      {session},
    )
  }
  return credentialIds
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as {code?: number}).code === 11000
}
