/**
 * @fileoverview The miniapps each workspace assigns through Fleet, and the workspace a miniapp token names.
 *
 * **What it is for.** A miniapp token names the person's workspace (`workspaceId`) only for a miniapp that
 * workspace assigned through Fleet. A company's miniapp can then admit exactly its own workspace's members,
 * and no other miniapp learns which workspace anyone belongs to.
 *
 * **Where the set comes from.** Fleet (MFM) pushes each workspace's whole set of assigned package names after
 * every assign or withdraw, and again when it reconciles at startup
 * (`PUT /api/internal/fleet/workspaces/:workspaceId/assigned-packages`, `api/internal/fleet.api.ts`). Core
 * keeps the last one (`workspace_assigned_packages`) and never asks Fleet, so a token mint never waits on it.
 *
 * **Pushes are revisioned.** A push applies only when its revision is newer than the one Core has: an equal
 * one is a repeat and changes nothing, an older one is refused (`stale_revision`, with Core's revision). A
 * push for a workspace that never existed is `not_found`, and one for a deleted workspace `workspace_deleted`.
 * A push writes the workspace document in its transaction, so it conflicts with the workspace's deletion and
 * never lands after it; deleting the workspace deletes its set (`clearAssignedPackages`).
 *
 * **Who it names.** `assigningWorkspace` answers the workspace the person is an active member of whose set
 * holds the package. A person belongs to at most one workspace; someone left with several from before that
 * rule gets the one they joined first that assigned the package. Leaving the workspace, or Fleet withdrawing
 * the miniapp, takes the workspace out of the person's next token.
 */

import type {ClientSession} from "mongoose"
import {withTransaction} from "../../connections/mongo.connection"
import {WorkspaceAssignedPackagesModel} from "../../models/workspace-assigned-packages.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {fail} from "./workspace-error"
import {loadActiveWorkspace, touchWorkspace} from "./workspace.service"

/** The most package names one set holds: the most miniapps Fleet lets a workspace assign. */
export const MAX_ASSIGNED_PACKAGES = 500
/** The longest package name a set holds. */
export const ASSIGNED_PACKAGE_NAME_MAX_LENGTH = 128

/** A push from Fleet: the workspace's whole set, and Fleet's revision of it. */
export interface AssignedPackagesWrite {
  packageNames: string[]
  revision: number
}

/** What Core holds after a push: `applied` is false for a repeat of the revision it already had. */
export interface AssignedPackagesAnswer {
  workspaceId: string
  packageNames: string[]
  revision: number
  applied: boolean
}

/**
 * A push's body: `packageNames`, at most {@link MAX_ASSIGNED_PACKAGES} names of at most
 * {@link ASSIGNED_PACKAGE_NAME_MAX_LENGTH} characters with no whitespace, and `revision`, a whole number, zero
 * or more. The names come back unique and sorted. Anything else is a 400 `invalid_request`.
 */
export function parseAssignedPackagesWrite(body: Record<string, unknown>): AssignedPackagesWrite {
  const {packageNames, revision} = body
  if (!Array.isArray(packageNames)) invalid("packageNames must be an array of package names")
  if (packageNames.length > MAX_ASSIGNED_PACKAGES) {
    invalid(`packageNames may hold at most ${MAX_ASSIGNED_PACKAGES} package names`)
  }
  for (const name of packageNames) {
    if (typeof name !== "string" || !name || name.length > ASSIGNED_PACKAGE_NAME_MAX_LENGTH || /\s/.test(name)) {
      invalid(
        `each package name must be a string of 1 to ${ASSIGNED_PACKAGE_NAME_MAX_LENGTH} characters with no whitespace`,
      )
    }
  }
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    invalid("revision must be a whole number, zero or more")
  }
  return {packageNames: [...new Set(packageNames as string[])].sort(), revision}
}

/**
 * Replace the workspace's set with `write` when its revision is newer than Core's. Throws `stale_revision`
 * (details: Core's `revision`) for an older one, `not_found` for a workspace that never existed and
 * `workspace_deleted` for a deleted one.
 */
export async function replaceAssignedPackages(
  workspaceId: string,
  write: AssignedPackagesWrite,
): Promise<AssignedPackagesAnswer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(session => replaceIn(session, workspaceId, write))
    } catch (err) {
      // Two first pushes for one workspace at once: the second insert meets the first's unique key. Its next
      // attempt finds the set and decides by revision like any other push.
      if (attempt === 0 && isDuplicateKeyError(err)) continue
      throw err
    }
  }
}

async function replaceIn(
  session: ClientSession,
  workspaceId: string,
  write: AssignedPackagesWrite,
): Promise<AssignedPackagesAnswer> {
  await loadActiveWorkspace(session, workspaceId)
  const existing = await WorkspaceAssignedPackagesModel.findOne({workspaceId}).session(session).lean()
  if (existing && write.revision < existing.revision) {
    fail("stale_revision", `Core has revision ${existing.revision} of this workspace's assigned packages`, {
      revision: existing.revision,
    })
  }
  if (existing && write.revision === existing.revision) {
    return {workspaceId, packageNames: [...existing.packageNames], revision: existing.revision, applied: false}
  }
  // Writing the workspace conflicts with its deletion, so a set never lands after the workspace is gone.
  await touchWorkspace(session, workspaceId)
  if (existing) {
    const updated = await WorkspaceAssignedPackagesModel.updateOne(
      {workspaceId, revision: existing.revision},
      {$set: {packageNames: write.packageNames, revision: write.revision}},
      {session},
    )
    if (updated.matchedCount !== 1) throw new Error(`assigned packages of ${workspaceId} changed during the push`)
  } else {
    await WorkspaceAssignedPackagesModel.create([{workspaceId, packageNames: write.packageNames, revision: write.revision}], {
      session,
    })
  }
  return {workspaceId, packageNames: write.packageNames, revision: write.revision, applied: true}
}

/** Delete the workspace's set, in the caller's transaction: its deletion's. */
export async function clearAssignedPackages(session: ClientSession, workspaceId: string): Promise<void> {
  await WorkspaceAssignedPackagesModel.deleteOne({workspaceId}, {session})
}

/**
 * The workspace a miniapp token for `packageName` names for this person: the workspace they are an active
 * member of whose assigned set holds the package, or null. With several such memberships (only from before
 * one workspace per person), the one that started first. A person in no workspace costs one query.
 */
export async function assigningWorkspace(mentraUserId: string, packageName: string): Promise<string | null> {
  // A missing id or package must not become a `null` filter.
  if (typeof mentraUserId !== "string" || !mentraUserId || typeof packageName !== "string" || !packageName) return null
  // Sorted here, not by the query: a person has at most a few, and Azure Cosmos DB for MongoDB refuses a
  // sort no index serves, which would refuse every token.
  const memberships = (
    await WorkspaceMembershipModel.find({mentraUserId, status: "active"})
      .select({_id: 0, workspaceId: 1, membershipId: 1, startedAt: 1})
      .lean<Array<{workspaceId: string; membershipId: string; startedAt?: Date | null}>>()
  ).sort(
    (a, b) =>
      startedAtMs(a) - startedAtMs(b) || (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0),
  )
  if (memberships.length === 0) return null
  const assigned = await WorkspaceAssignedPackagesModel.find({
    workspaceId: {$in: memberships.map(membership => membership.workspaceId)},
    packageNames: packageName,
  })
    .select({_id: 0, workspaceId: 1})
    .lean<Array<{workspaceId: string}>>()
  if (assigned.length === 0) return null
  const assigning = new Set(assigned.map(set => set.workspaceId))
  return memberships.find(membership => assigning.has(membership.workspaceId))?.workspaceId ?? null
}

function startedAtMs(membership: {startedAt?: Date | null}): number {
  return membership.startedAt instanceof Date ? membership.startedAt.getTime() : 0
}

function invalid(message: string): never {
  fail("invalid_request", message)
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as {code?: unknown}).code === 11000
}
