/**
 * @fileoverview What an automatic workspace holds: the check behind `replaceable` and behind giving way.
 *
 * An automatic workspace **holds nothing** when it is active and automatic, has no deletion hold, the
 * person's Owner membership is its only active membership (an imported membership waiting for its person
 * counts as another), and it has no pending invitation that has not expired, no unrevoked key, and no
 * license that has not ended. `workspacesHoldingNothing` asks about many workspaces at once, one read per
 * check and each check only on the workspaces the earlier ones left. `listWorkspacesForUser` marks such a
 * workspace `replaceable` (`replaceableWorkspaces`, outside any transaction), and
 * `yieldAutomaticWorkspace` deletes it (`holdsNothing`, in the transaction that gives the person a
 * membership elsewhere).
 *
 * This module imports only models, so `workspace.service` and `automatic-workspace.service` can both use
 * it without importing each other for these checks.
 */

import type {WorkspaceDeletionHold} from "@mentra/workspace-contract"
import type {ClientSession} from "mongoose"
import {AccessCredentialModel} from "../../models/access-credential.model"
import {LicenseModel} from "../../models/license.model"
import {WorkspaceInvitationModel} from "../../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel, type WorkspaceRow} from "../../models/workspace.model"

/**
 * The workspace's deletion holds in the contract's shape, sorted by service (`count` only where the
 * service gave one). A workspace written before holds existed has none.
 */
export function deletionHoldsOf(row: Pick<WorkspaceRow, "deletionHolds">): WorkspaceDeletionHold[] {
  const stored = (row.deletionHolds ?? []) as Array<{service: string; reason: string; count?: number | null}>
  return stored
    .map(hold => ({
      service: hold.service,
      reason: hold.reason,
      ...(typeof hold.count === "number" ? {count: hold.count} : {}),
    }))
    .sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0))
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

/**
 * Which of `workspaceIds` hold nothing for `mentraUserId`. Each check is one read for all of them, and a
 * check runs only on the workspaces every earlier one left.
 */
export async function workspacesHoldingNothing(
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

/** A usable id: a string with something in it, so a missing one never becomes a `null` filter. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
