/**
 * @fileoverview One workspace per person: the guard.
 *
 * A person holds at most one active workspace membership. The rule has to hold under concurrency, so it
 * cannot be a check followed by an insert: two accepts of two invitations at the same moment would both pass
 * the check. The arbiter is a **guard document**, one per person, whose `_id` is derived from the Core user id.
 * Inserting a second one is a duplicate-key error whatever else is running, and the guard is written in the
 * same transaction as the membership it guards, so they commit or fail together.
 *
 * The guard lives in the memberships collection itself, not in a collection of its own. A transaction that
 * writes two collections is refused by Azure Cosmos DB for MongoDB (RU), and a unique index cannot be added to
 * a collection that already holds documents there; `_id` is unique everywhere and already indexed, so the
 * design needs neither. On a Mongo replica set it behaves identically.
 *
 * Guard documents share the collection with memberships, so they are built never to match a membership query:
 * they carry none of `workspaceId`, `mentraUserId`, `status`, `role` or `pendingWorkosUserId`, and their
 * `membershipId` (unique, required by the collection's unique index) is their own `_id`, which no `wm_` id can
 * equal. Their fields are `guardedUserId`, `guardedWorkspaceId` and `guardedMembershipId`. Nothing reads the
 * collection unfiltered; `membership-guard.service.test.ts` pins that every listing the services make leaves
 * guards out.
 *
 * Lifecycle (this module's functions are called from the services that make the change):
 *  - created at accept, create, `recoverOwnership` and the claim of an imported membership (an unclaimed
 *    membership has no account, so no guard until its claim);
 *  - released when the membership ends: leave, removal, account deletion (`endMembership`), and workspace
 *    deletion for every member;
 *  - kept by `merged_duplicate` (the surviving membership is the one it names), which ends only unclaimed
 *    memberships that had none;
 *  - written at startup for everyone who has exactly one active membership (`initializeGuards`). Someone with
 *    several has none until `scripts/one-workspace-cleanup.ts` keeps one; until then every further join is
 *    refused because the person already holds an active membership.
 */

import {createLogger} from "@mentra/cloud-shared"
import type {ClientSession} from "mongoose"
import {WorkspaceMembershipModel} from "../../models/workspace-membership.model"
import {fail} from "./workspace-error"

const logger = createLogger("core").child({service: "membership-guard"})

export const GUARD_KIND = "one_workspace_guard"

/** The guard's `_id` (and `membershipId`) for a Core user. Not shaped like a membership id (`wm_...`). */
export function guardIdOf(mentraUserId: string): string {
  return `ows:${mentraUserId}`
}

export interface GuardRow {
  _id: string
  membershipId: string
  kind: typeof GUARD_KIND
  guardedUserId: string
  guardedWorkspaceId: string
  guardedMembershipId: string
  createdAt: Date
}

function guardOf(mentraUserId: string, held: {workspaceId: string; membershipId: string}): GuardRow {
  const id = guardIdOf(mentraUserId)
  return {
    _id: id,
    membershipId: id,
    kind: GUARD_KIND,
    guardedUserId: mentraUserId,
    guardedWorkspaceId: held.workspaceId,
    guardedMembershipId: held.membershipId,
    createdAt: new Date(),
  }
}

/** The raw collection: guards are not memberships, so they never go through the membership schema. */
const guards = () => WorkspaceMembershipModel.collection

function isDuplicateKey(error: unknown): boolean {
  for (let candidate: any = error, depth = 0; candidate && depth < 5; candidate = candidate.cause, depth += 1) {
    if (candidate.code === 11000) return true
  }
  return false
}

/**
 * Whether `mentraUserId` may take a first membership: no guard, and no active membership (which also refuses
 * the person who has several and has not been cleaned up yet).
 */
export async function canJoinWorkspace(session: ClientSession, mentraUserId: string): Promise<boolean> {
  if (await guards().findOne({_id: guardIdOf(mentraUserId)} as any, {session, projection: {_id: 1}})) return false
  return !(await WorkspaceMembershipModel.exists({mentraUserId, status: "active"}).session(session))
}

/**
 * Take the guard for a person's new membership, in the transaction that creates the membership. Refused with
 * `already_in_workspace` (409) when they already hold a workspace, whether that was seen by the read or lost
 * to a concurrent transaction at the insert.
 */
export async function acquireGuard(
  session: ClientSession,
  mentraUserId: string,
  held: {workspaceId: string; membershipId: string},
): Promise<void> {
  if (!(await canJoinWorkspace(session, mentraUserId))) {
    fail("already_in_workspace", "already in a workspace; leave it before joining another")
  }
  await insertGuard(session, mentraUserId, held)
}

/** The insert alone, for a caller that has already decided with {@link canJoinWorkspace}. */
export async function insertGuard(
  session: ClientSession,
  mentraUserId: string,
  held: {workspaceId: string; membershipId: string},
): Promise<void> {
  try {
    await guards().insertOne(guardOf(mentraUserId, held) as any, {session})
  } catch (error) {
    if (isDuplicateKey(error)) fail("already_in_workspace", "already in a workspace; leave it before joining another")
    throw error
  }
}

/** Release the guard a membership held. A guard that names another membership of the person stays. */
export async function releaseGuard(session: ClientSession, mentraUserId: string, membershipId: string): Promise<void> {
  await guards().deleteOne({_id: guardIdOf(mentraUserId), guardedMembershipId: membershipId} as any, {session})
}

/** Release every guard that names `workspaceId`, for the members a workspace deletion ends. */
export async function releaseGuardsOfWorkspace(
  session: ClientSession,
  workspaceId: string,
  mentraUserIds: readonly string[],
): Promise<void> {
  if (mentraUserIds.length === 0) return
  await guards().deleteMany(
    {_id: {$in: mentraUserIds.map(guardIdOf)}, guardedWorkspaceId: workspaceId} as any,
    {session},
  )
}

/** Set the guard of a person to name `held`, replacing any (the cleanup script's, after it keeps one). */
export async function setGuard(
  session: ClientSession,
  mentraUserId: string,
  held: {workspaceId: string; membershipId: string},
): Promise<void> {
  const row = guardOf(mentraUserId, held)
  await guards().replaceOne({_id: row._id} as any, row as any, {session, upsert: true})
}

/**
 * Write the guard of everyone who has exactly one active membership and no guard yet. Idempotent (it never
 * overwrites a guard) and safe to run while Core serves: a person who joins or leaves meanwhile does so
 * through the services above, which take and release the guard themselves. Returns how many it wrote.
 */
export async function initializeGuards(batchSize = 500): Promise<number> {
  const cursor = WorkspaceMembershipModel.aggregate<{
    _id: string
    count: number
    membershipId: string
    workspaceId: string
  }>([
    {$match: {status: "active", mentraUserId: {$type: "string"}}},
    {
      $group: {
        _id: "$mentraUserId",
        count: {$sum: 1},
        membershipId: {$first: "$membershipId"},
        workspaceId: {$first: "$workspaceId"},
      },
    },
    {$match: {count: 1}},
  ]).cursor()

  let written = 0
  let batch: GuardRow[] = []
  const flush = async () => {
    if (batch.length === 0) return
    const result = await guards().bulkWrite(
      batch.map(({_id, ...fields}) => ({updateOne: {filter: {_id}, update: {$setOnInsert: fields}, upsert: true}})) as any,
      {ordered: false},
    )
    written += result.upsertedCount
    batch = []
  }
  for await (const person of cursor) {
    batch.push(guardOf(person._id, {workspaceId: person.workspaceId, membershipId: person.membershipId}))
    if (batch.length >= batchSize) await flush()
  }
  await flush()
  if (written > 0) logger.info({written}, "wrote one-workspace guards for people with a single membership")
  return written
}
