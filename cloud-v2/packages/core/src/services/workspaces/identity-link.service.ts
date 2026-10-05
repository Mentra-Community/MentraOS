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
 *  1. the WorkOS email is verified and a Mentra (GoTrue) account with that
 *     confirmed email exists: use that account's user (`linkedVia: verified_email`);
 *  2. otherwise a user in the `workos` tenant keyed by the WorkOS user id
 *     (`linkedVia: workos_tenant`).
 *
 * Memberships migrated under a WorkOS user id (`pendingWorkosUserId`) are
 * claimed for the linked user on first sight (in the same transaction as the
 * link) and again on any later sign-in that still finds one, so a migration that
 * lands after the person has already signed in is not stranded.
 */

import {createLogger} from "@mentra/cloud-shared"
import {roleAtLeast, type WorkspaceRole} from "@mentra/workspace-contract"
import {ulid} from "ulid"
import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {IdentityLinkModel, type IdentityLinkMethod} from "../../models/identity-link.model"
import {WorkspaceAuditEventModel} from "../../models/workspace-audit-event.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"
import {findUserByEmail, isGotrueAdminConfigured} from "../account/gotrue.client"
import {findOrCreateUser} from "../user.service"

const logger = createLogger("core").child({service: "identity-link.service"})

const PROVIDER = "workos"

export interface WorkosIdentity {
  workosUserId: string
  email: string | null
  emailVerified: boolean
  name: string | null
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
    await withTransaction(async session => {
      await IdentityLinkModel.create([{provider: PROVIDER, subject, mentraUserId, email, linkedVia}], {session})
      await claimPendingMemberships(session, subject, mentraUserId)
    })
  } catch (err) {
    // A concurrent first login linked this WorkOS user first. Its transaction
    // owns the link; ours rolled back, so resolve to the winner. The winner's
    // claim has normally run already, but this resolution must not depend on
    // that, so claim for the winner's user too (a no-op once nothing is pending).
    if (!isDuplicateKeyError(err)) throw err
    const winner = await IdentityLinkModel.findOne({provider: PROVIDER, subject}).lean()
    if (!winner) throw err
    await claimPendingIfAny(subject, winner.mentraUserId)
    return {mentraUserId: winner.mentraUserId}
  }
  logger.info({mentraUserId, linkedVia}, "linked WorkOS identity to Mentra user")
  return {mentraUserId}
}

async function chooseMentraUser(
  subject: string,
  email: string | null,
  emailVerified: boolean,
): Promise<{mentraUserId: string; linkedVia: IdentityLinkMethod}> {
  // Only a verified email may claim an existing account. An unverified address
  // proves nothing, so it never reaches GoTrue. A deployment with no GoTrue
  // admin credentials has no Mentra accounts to match, so it skips the lookup.
  // The link is permanent, so a configured directory that is erroring must fail
  // this sign-in (strict) rather than read as "no Mentra account" and link the
  // person to a separate workos-tenant user.
  if (emailVerified && email && isGotrueAdminConfigured()) {
    const account = await findUserByEmail(email, {strict: true})
    if (account?.emailVerified) {
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
 * Hand memberships migrated under `pendingWorkosUserId` to the linked user.
 * A pending row in a workspace where the user already has an active membership
 * would break the one-active-membership rule, so it is ended (`removed`) and
 * audited instead and the membership the user already held survives. If the
 * pending row carried the higher role, the surviving row is raised to it, so
 * merging never takes access away (and a workspace never loses its owner).
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
    if (raised) {
      await WorkspaceMembershipModel.updateOne(
        {membershipId: kept.membershipId, status: "active"},
        {$set: {role: pendingRole}},
        {session},
      )
      // A role change can alter what the member may do, so it invalidates cached authorization.
      await WorkspaceModel.updateOne(
        {workspaceId: duplicate.workspaceId},
        {$inc: {authorizationRevision: 1}},
        {session},
      )
    }
    await WorkspaceMembershipModel.updateOne(
      {membershipId: duplicate.membershipId, status: "active"},
      {$set: {status: "ended", endedAt: now, endedReason: "removed"}},
      {session},
    )
    await WorkspaceAuditEventModel.create(
      [
        {
          eventId: ulid(),
          organizationId: duplicate.organizationId,
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
          },
          occurredAt: now,
        },
      ],
      {session},
    )
  }

  // Everything still pending belongs to this user now.
  await WorkspaceMembershipModel.updateMany(
    {pendingWorkosUserId: workosUserId, status: "active"},
    {$set: {mentraUserId, pendingWorkosUserId: null}},
    {session},
  )
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as {code?: number}).code === 11000
}
