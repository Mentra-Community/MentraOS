/**
 * @fileoverview The workspace that manages a person's device.
 *
 * A person may belong to several workspaces, but their phone is managed by at most one: its Fleet installs that
 * workspace's miniapps and only that workspace sees the device. Which one follows from the person's active
 * memberships alone, so there is nothing to store and nothing to migrate:
 *
 *  1. the earliest-joined membership (when the person took it up: `claimedAt` for a membership imported from the
 *     Store and claimed later, else `startedAt`; then the membership id) in a workspace that is **not** the
 *     person's own automatic workspace: the first real workspace they joined keeps managing them until they
 *     leave it, and a later join never takes it over. That is where Fleet's interval history starts a membership
 *     too, so Fleet's views and the phone agree on who manages it;
 *  2. otherwise their own automatic workspace (the one Core made for them, `automatic: true` and created by
 *     them), the earliest if somehow several;
 *  3. otherwise none.
 *
 * Rule 2 exists because Fleet is on for every workspace while it is being built, so a person's automatic
 * workspace manages them until they join a real one. Someone else's automatic workspace that a person joined
 * as a member is a real workspace to them.
 *
 * Anything that answers "the person's workspace" for a device reads this: the Mentra App's `GET /mine`, the
 * accept that answers what `/mine` would, `POST /leave` without a workspace, and Fleet's desired state
 * (`GET /api/internal/workspaces/users/:mentraUserId/managing-workspace`).
 */

import type {MembershipSummary, WorkspaceRole, WorkspaceSummary} from "@mentra/workspace-contract"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {WorkspaceModel} from "../../models/workspace.model"

/** The workspace managing a person's device, and their membership in it. */
export interface ManagingWorkspace {
  workspace: WorkspaceSummary
  membership: MembershipSummary
  /** Whether it is the person's own automatic workspace: it manages them only while they have no other. */
  automatic: boolean
}

interface MembershipFields {
  workspaceId: string
  membershipId: string
  role: string
  startedAt?: Date | null
  claimedAt?: Date | null
}

interface WorkspaceFields {
  workspaceId: string
  name: string
  status: "active" | "deleted"
  authorizationRevision: number
  automatic?: boolean | null
  createdByMentraUserId?: string | null
}

// Not `workspace.service`'s `isId`: that module imports `pickManaging` from here, and the two would import each other.
const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

/** When the person took the membership up: its claim for an imported one, else its start. */
const joinedAtMs = (row: {startedAt?: Date | null; claimedAt?: Date | null}) =>
  row.claimedAt instanceof Date ? row.claimedAt.getTime() : row.startedAt instanceof Date ? row.startedAt.getTime() : 0

/** Earliest join first, then the smallest membership id, so the answer never depends on read order. */
function joinOrder(a: MembershipFields, b: MembershipFields): number {
  return joinedAtMs(a) - joinedAtMs(b) || (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0)
}

/** Whether `workspace` is `mentraUserId`'s own automatic workspace. */
export function isOwnAutomatic(workspace: Pick<WorkspaceFields, "automatic" | "createdByMentraUserId">, mentraUserId: string): boolean {
  return workspace.automatic === true && workspace.createdByMentraUserId === mentraUserId
}

/**
 * Pick the managing membership among `memberships` (each with its active workspace), by the rule in the file
 * header. Pure, so the order is pinned by unit tests and shared by every caller.
 */
export function pickManaging<M extends MembershipFields, W extends Pick<WorkspaceFields, "automatic" | "createdByMentraUserId">>(
  mentraUserId: string,
  candidates: ReadonlyArray<{membership: M; workspace: W}>,
): {membership: M; workspace: W} | null {
  const sorted = [...candidates].sort((a, b) => joinOrder(a.membership, b.membership))
  return (
    sorted.find(candidate => !isOwnAutomatic(candidate.workspace, mentraUserId)) ??
    sorted.find(candidate => isOwnAutomatic(candidate.workspace, mentraUserId)) ??
    null
  )
}

/** The workspace managing `mentraUserId`'s device, or null when they belong to none. Two reads. */
export async function managingWorkspaceOf(mentraUserId: string): Promise<ManagingWorkspace | null> {
  // A missing id must not become a `null` filter.
  if (!isId(mentraUserId)) return null
  const memberships = await WorkspaceMembershipModel.find({mentraUserId, status: "active"})
    .select({_id: 0, workspaceId: 1, membershipId: 1, role: 1, startedAt: 1, claimedAt: 1})
    .lean<MembershipFields[]>()
  if (memberships.length === 0) return null
  const workspaces = await WorkspaceModel.find({workspaceId: {$in: memberships.map(row => row.workspaceId)}, status: "active"})
    .select({_id: 0, workspaceId: 1, name: 1, status: 1, authorizationRevision: 1, automatic: 1, createdByMentraUserId: 1})
    .lean<WorkspaceFields[]>()
  const byId = new Map(workspaces.map(row => [row.workspaceId, row]))
  const candidates = memberships.flatMap(membership => {
    const workspace = byId.get(membership.workspaceId)
    return workspace ? [{membership, workspace}] : []
  })
  const picked = pickManaging(mentraUserId, candidates)
  if (!picked) return null
  const {membership, workspace} = picked
  return {
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      status: workspace.status,
      authorizationRevision: workspace.authorizationRevision,
    },
    membership: {membershipId: membership.membershipId, role: membership.role as WorkspaceRole},
    automatic: isOwnAutomatic(workspace, mentraUserId),
  }
}
