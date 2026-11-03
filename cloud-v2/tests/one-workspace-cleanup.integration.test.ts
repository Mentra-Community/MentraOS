/**
 * @fileoverview The one-workspace cleanup script, against a real replica set.
 *
 * `packages/core/scripts/one-workspace-cleanup.ts` brings everyone who holds several memberships (from before
 * the guard) down to one. What is pinned here: the dry run writes nothing; the kept membership is the highest
 * role, then the earliest join; every removal goes through Core's normal removal (audited as the system, on the
 * change feed, with the workspace's revision bumped); a workspace's last Owner is replaced by its next member
 * before they are removed; a sole member is removed anyway and the workspace is reported ownerless; a
 * workspace whose other members cannot be promoted is left alone and reported; a concurrent change makes the
 * script plan again instead of removing the wrong membership; and a re-run finds nothing left.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/one-workspace-cleanup.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import type {Model} from "mongoose"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {cleanupOneWorkspacePerPerson, keepOrder, parseArgs, UsageError} from "../packages/core/scripts/one-workspace-cleanup"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {GUARD_KIND, guardIdOf} from "../packages/core/src/services/workspaces/membership-guard.service"
import * as workspaces from "../packages/core/src/services/workspaces/workspace.service"
import {createWorkspace, getWorkspace, type Actor} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

const MODELS: Model<any>[] = [
  UserModel,
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
]

let databaseUrl: string
let verified = false

type UserActor = Actor & {kind: "user"}
const user = (id: string): UserActor => ({
  kind: "user",
  mentraUserId: id,
  email: `${id}@example.test`,
  emailVerified: true,
  isOrganizationAdmin: false,
})

let counter = 0
const DAY = 86_400_000

/** A membership written directly: how people came to hold several before the guard. */
async function legacyMember(
  workspaceId: string,
  mentraUserId: string | null,
  role: string,
  fields: Record<string, unknown> = {},
) {
  const membershipId = `wm_clean_${counter++}`
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId,
      ...(mentraUserId === null ? {pendingWorkosUserId: `user_pending_${counter}`} : {}),
      email: mentraUserId ? `${mentraUserId}@example.test` : null,
      role,
      status: "active",
      startedAt: new Date(Date.now() - 10 * DAY),
      ...fields,
    }),
  )
  return membershipId
}

/** A workspace made by `ownerId` (who owns it). */
async function workspaceOf(ownerId: string, name = `W${counter++}`) {
  return (await createWorkspace(user(ownerId), {name})).workspaceId
}

const activeOf = (mentraUserId: string) =>
  WorkspaceMembershipModel.find({mentraUserId, status: "active"}).sort({workspaceId: 1}).lean()

async function guardOf(mentraUserId: string): Promise<Record<string, any> | null> {
  return (await WorkspaceMembershipModel.collection.findOne({_id: guardIdOf(mentraUserId)} as any)) as Record<string, any> | null
}

async function snapshot() {
  return {
    memberships: await WorkspaceMembershipModel.find({}).sort({membershipId: 1}).lean(),
    workspaces: await WorkspaceModel.find({}).sort({workspaceId: 1}).lean(),
    events: await WorkspaceAuditEventModel.countDocuments({}),
  }
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("one-workspace-cleanup")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
})

/** Two workspaces `mu_p` is in (a developer in one, an admin in the other), each owned by someone else. */
async function personInTwo() {
  const a = await workspaceOf("mu_owner_a", "A")
  const b = await workspaceOf("mu_owner_b", "B")
  const inA = await legacyMember(a, "mu_p", "developer", {startedAt: new Date(Date.now() - 20 * DAY)})
  const inB = await legacyMember(b, "mu_p", "admin", {startedAt: new Date(Date.now() - 5 * DAY)})
  return {a, b, inA, inB}
}

describe("the dry run", () => {
  test("reports who would keep what and writes nothing", async () => {
    const {a, b, inA, inB} = await personInTwo()
    const before = await snapshot()

    const report = await cleanupOneWorkspacePerPerson({apply: false})

    expect(report.apply).toBe(false)
    expect(report.people).toEqual([
      {
        mentraUserId: "mu_p",
        kept: {workspaceId: b, membershipId: inB, role: "admin"},
        ended: [{workspaceId: a, membershipId: inA, role: "developer"}],
        blocked: [],
      },
    ])
    expect(report.ownerless).toEqual([])
    expect(await snapshot()).toEqual(before)
    expect(await guardOf("mu_p")).toBeNull()
  })

  test("names the workspaces a sole-member removal would leave ownerless, and still writes nothing", async () => {
    const solo = await workspaceOf("mu_solo", "Solo")
    const home = await workspaceOf("mu_home", "Home")
    // mu_solo is the only member of Solo and is also an owner of Home, earlier.
    await legacyMember(home, "mu_solo", "owner", {startedAt: new Date(Date.now() - 50 * DAY)})
    const before = await snapshot()

    const report = await cleanupOneWorkspacePerPerson({apply: false})

    expect(report.people[0]!.ended).toEqual([
      {workspaceId: solo, membershipId: expect.any(String), role: "owner", soleMember: true},
    ])
    expect(report.ownerless).toEqual([solo])
    expect(await snapshot()).toEqual(before)
  })
})

describe("applying", () => {
  test("keeps the higher role, ends the other through the normal removal, and writes the guard", async () => {
    const {a, b, inA, inB} = await personInTwo()
    const revisionA = (await getWorkspace(a))!.authorizationRevision
    const revisionB = (await getWorkspace(b))!.authorizationRevision

    const report = await cleanupOneWorkspacePerPerson({apply: true})

    expect((await activeOf("mu_p")).map(row => row.membershipId)).toEqual([inB])
    expect(await WorkspaceMembershipModel.findOne({membershipId: inA}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    // The removal bumped the workspace it happened in, and only that one.
    expect((await getWorkspace(a))!.authorizationRevision).toBe(revisionA + 1)
    expect((await getWorkspace(b))!.authorizationRevision).toBe(revisionB)
    // Audited as the system, with a feed number.
    const removed = await WorkspaceAuditEventModel.find({action: "membership.removed"}).lean()
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({
      workspaceId: a,
      actor: {kind: "system"},
      target: {membershipId: inA, mentraUserId: "mu_p"},
      after: {status: "ended", endedReason: "removed"},
    })
    expect(typeof removed[0]!.seq).toBe("number")
    // The guard names what they kept.
    expect(await guardOf("mu_p")).toMatchObject({kind: GUARD_KIND, guardedWorkspaceId: b, guardedMembershipId: inB})
    expect(report.people).toHaveLength(1)
    expect(report.gaveUp).toEqual([])
  })

  test("on equal roles the earlier join is kept, then the smaller id", async () => {
    const a = await workspaceOf("mu_owner_a")
    const b = await workspaceOf("mu_owner_b")
    const c = await workspaceOf("mu_owner_c")
    await legacyMember(a, "mu_p", "member", {startedAt: new Date(Date.now() - 1 * DAY)})
    const earliest = await legacyMember(b, "mu_p", "member", {startedAt: new Date(Date.now() - 9 * DAY)})
    await legacyMember(c, "mu_p", "member", {startedAt: new Date(Date.now() - 3 * DAY)})

    await cleanupOneWorkspacePerPerson({apply: true})

    expect((await activeOf("mu_p")).map(row => row.membershipId)).toEqual([earliest])
    expect(keepOrder({role: "member", startedAt: new Date(1), membershipId: "wm_a"} as any, {role: "member", startedAt: new Date(1), membershipId: "wm_b"} as any)).toBeLessThan(0)
  })

  test("is idempotent: a second run finds nothing, writes nothing", async () => {
    await personInTwo()
    await cleanupOneWorkspacePerPerson({apply: true})
    const before = await snapshot()

    const again = await cleanupOneWorkspacePerPerson({apply: true})

    expect(again.people).toEqual([])
    expect(again.guardsWritten).toBe(0)
    expect(await snapshot()).toEqual(before)
  })

  test("writes the guard for people who hold exactly one membership and had none", async () => {
    const a = await workspaceOf("mu_owner_a")
    await legacyMember(a, "mu_single", "member")

    const report = await cleanupOneWorkspacePerPerson({apply: true})

    expect(report.guardsWritten).toBe(1)
    expect(await guardOf("mu_single")).toMatchObject({guardedWorkspaceId: a})
  })

  test("revokes what the ended membership created, as the normal removal does", async () => {
    const {a, inA} = await personInTwo()
    await WorkspaceInvitationModel.create({
      invitationId: "winv_clean_1",
      workspaceId: a,
      email: "friend@example.test",
      role: "member",
      tokenHash: "hash_clean_1",
      status: "pending",
      invitedByAuthority: "membership",
      invitedByMembershipId: inA,
      invitedByMentraUserId: "mu_p",
      expiresAt: new Date(Date.now() + DAY),
    })

    await cleanupOneWorkspacePerPerson({apply: true})

    expect((await WorkspaceInvitationModel.findOne({invitationId: "winv_clean_1"}).lean())!.status).toBe("revoked")
  })
})

describe("a workspace's last Owner", () => {
  test("is replaced by the next member (highest role, earliest joined) before they are removed", async () => {
    const home = await workspaceOf("mu_home", "Home")
    const lone = await workspaceOf("mu_lone", "Lone")
    // mu_lone owns Lone and is an owner of Home too, from earlier (so Home is kept).
    await legacyMember(home, "mu_lone", "owner", {startedAt: new Date(Date.now() - 50 * DAY)})
    await legacyMember(lone, "mu_dev", "developer", {startedAt: new Date(Date.now() - 9 * DAY)})
    const admin = await legacyMember(lone, "mu_adm", "admin", {startedAt: new Date(Date.now() - 2 * DAY)})
    const revision = (await getWorkspace(lone))!.authorizationRevision

    const dry = await cleanupOneWorkspacePerPerson({apply: false})
    expect(dry.people[0]!.ended[0]).toMatchObject({workspaceId: lone, promoted: {membershipId: admin, role: "admin"}})

    const report = await cleanupOneWorkspacePerPerson({apply: true})

    expect(report.ownerless).toEqual([])
    expect(await WorkspaceMembershipModel.findOne({membershipId: admin}).lean()).toMatchObject({role: "owner", status: "active"})
    const promoted = await WorkspaceMembershipModel.findOne({membershipId: admin}).lean()
    expect(promoted!.roleHistory.map(entry => entry.role)).toEqual(["admin", "owner"])
    expect(promoted!.roleHistory.at(-1)!.authorizationRevision).toBe(revision + 1)
    const events = await WorkspaceAuditEventModel.find({workspaceId: lone, action: {$in: ["membership.role_changed", "membership.removed"]}})
      .sort({seq: 1})
      .lean()
    expect(events.map(event => event.action)).toEqual(["membership.role_changed", "membership.removed"])
    expect(events.every(event => event.actor.kind === "system")).toBe(true)
  })

  test("a sole member is removed anyway, the workspace is reported ownerless, and nothing else bypasses protection", async () => {
    const solo = await workspaceOf("mu_solo", "Solo")
    const home = await workspaceOf("mu_home", "Home")
    await legacyMember(home, "mu_solo", "owner", {startedAt: new Date(Date.now() - 50 * DAY)})

    const report = await cleanupOneWorkspacePerPerson({apply: true})

    expect(report.ownerless).toEqual([solo])
    expect((await activeOf("mu_solo")).map(row => row.workspaceId)).toEqual([home])
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: solo, status: "active"})).toBe(0)
  })

  test("a workspace whose other members cannot be promoted is left alone and reported as blocked", async () => {
    const stuck = await workspaceOf("mu_stuck", "Stuck")
    const home = await workspaceOf("mu_home", "Home")
    await legacyMember(home, "mu_stuck", "owner", {startedAt: new Date(Date.now() - 50 * DAY)})
    // The only other member is an imported one nobody has claimed: no account to promote.
    await legacyMember(stuck, null, "developer")
    // Someone who held both before the guard existed has no guard (creating Stuck made one here).
    await WorkspaceMembershipModel.collection.deleteOne({_id: guardIdOf("mu_stuck")} as any)

    const report = await cleanupOneWorkspacePerPerson({apply: true})

    expect(report.people[0]!.blocked).toEqual([
      {workspaceId: stuck, membershipId: expect.any(String), role: "owner", reason: "no_member_to_promote"},
    ])
    expect((await activeOf("mu_stuck")).map(row => row.workspaceId).sort()).toEqual([home, stuck].sort())
    // Still in two: no guard for them yet, so every join stays refused.
    expect(await guardOf("mu_stuck")).toBeNull()
  })

  test("a deleted account is never promoted", async () => {
    const lone = await workspaceOf("mu_lone", "Lone")
    const home = await workspaceOf("mu_home", "Home")
    await legacyMember(home, "mu_lone", "owner", {startedAt: new Date(Date.now() - 50 * DAY)})
    await legacyMember(lone, "mu_gone", "admin")
    await UserModel.create({mentraUserId: "mu_gone", tenantId: "mentra", tenantUserId: "sb-gone", supportTelemetryDeletedAt: new Date()})
    const live = await legacyMember(lone, "mu_live", "member")

    await cleanupOneWorkspacePerPerson({apply: true})

    expect(await WorkspaceMembershipModel.findOne({membershipId: live}).lean()).toMatchObject({role: "owner"})
  })
})

describe("concurrent changes", () => {
  test("a change to the workspace between planning and removal makes the script plan again, not remove the wrong membership", async () => {
    const {a, b, inA, inB} = await personInTwo()
    let interfered = false
    const real = workspaces.bumpRevision
    const spy = spyOn(workspaces, "bumpRevision").mockImplementation(async (session, workspaceId, expected, set) => {
      if (!interfered) {
        interfered = true
        // Between the plan and its write, someone makes the developer in A an owner and bumps A.
        await WorkspaceMembershipModel.updateOne({membershipId: inA}, {$set: {role: "owner"}})
        await WorkspaceModel.updateOne({workspaceId: a}, {$inc: {authorizationRevision: 1}})
      }
      return real(session, workspaceId, expected, set)
    })
    try {
      const report = await cleanupOneWorkspacePerPerson({apply: true})
      expect(report.gaveUp).toEqual([])
    } finally {
      spy.mockRestore()
    }

    // Planned again with the new role: A's membership is now the higher one, so it is B's that ends.
    expect(interfered).toBe(true)
    expect((await activeOf("mu_p")).map(row => row.membershipId)).toEqual([inA])
    expect(await WorkspaceMembershipModel.findOne({membershipId: inB}).lean()).toMatchObject({status: "ended"})
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.removed"})).toBe(1)
    expect(await guardOf("mu_p")).toMatchObject({guardedMembershipId: inA, guardedWorkspaceId: a})
    void b
  })
})

describe("the membership the script keeps", () => {
  /** `mu_p` in three workspaces: the admin one is kept, the two developer ones end. */
  async function personInThree() {
    const x = await workspaceOf("mu_owner_x", "X")
    const y = await workspaceOf("mu_owner_y", "Y")
    const z = await workspaceOf("mu_owner_z", "Z")
    const kept = await legacyMember(x, "mu_p", "admin", {startedAt: new Date(Date.now() - 30 * DAY)})
    const inY = await legacyMember(y, "mu_p", "developer", {startedAt: new Date(Date.now() - 20 * DAY)})
    const inZ = await legacyMember(z, "mu_p", "developer", {startedAt: new Date(Date.now() - 10 * DAY)})
    return {kept, inY, inZ}
  }

  test("leaving it between two removals does not leave the person with no membership", async () => {
    const {kept, inY, inZ} = await personInThree()
    let calls = 0
    const real = workspaces.loadActiveWorkspace
    const spy = spyOn(workspaces, "loadActiveWorkspace").mockImplementation(async (session, workspaceId) => {
      calls += 1
      const workspace = await real(session, workspaceId)
      // The second removal's transaction has read (its snapshot is taken); now the person leaves the membership
      // the plan keeps. The removal's write to that membership must conflict, so the transaction starts over and
      // sees the leave, rather than committing on a snapshot where the kept membership is still active.
      if (calls === 2) {
        await WorkspaceMembershipModel.updateOne({membershipId: kept}, {$set: {status: "ended", endedAt: new Date(), endedReason: "left"}})
      }
      return workspace
    })
    try {
      const report = await cleanupOneWorkspacePerPerson({apply: true})
      expect(report.gaveUp).toEqual([])
    } finally {
      spy.mockRestore()
    }

    expect(calls).toBeGreaterThanOrEqual(3)
    const active = await activeOf("mu_p")
    // The first removal went through; the second was refused because the kept membership was gone, so the other
    // developer membership stays rather than the person ending with nothing.
    expect(active).toHaveLength(1)
    expect([inY, inZ]).toContain(active[0]!.membershipId)
    expect(await guardOf("mu_p")).toMatchObject({guardedMembershipId: active[0]!.membershipId})
  })

  test("a role change to it that reorders the person's memberships is planned again, not applied to the old plan", async () => {
    const {kept, inY, inZ} = await personInThree()
    let calls = 0
    const real = workspaces.loadActiveWorkspace
    const spy = spyOn(workspaces, "loadActiveWorkspace").mockImplementation(async (session, workspaceId) => {
      calls += 1
      // Before the second removal, the kept admin is demoted to viewer: a developer membership now ranks above it.
      if (calls === 2) await WorkspaceMembershipModel.updateOne({membershipId: kept}, {$set: {role: "viewer"}})
      return real(session, workspaceId)
    })
    try {
      const report = await cleanupOneWorkspacePerPerson({apply: true})
      expect(report.gaveUp).toEqual([])
    } finally {
      spy.mockRestore()
    }

    // Replanned against the new roles: exactly one membership is left, and it is the highest-ranked one now.
    const active = await activeOf("mu_p")
    expect(active).toHaveLength(1)
    expect(active[0]!.role).toBe("developer")
    expect([inY, inZ]).toContain(active[0]!.membershipId)
    expect(await guardOf("mu_p")).toMatchObject({guardedMembershipId: active[0]!.membershipId})
  })
})

describe("the command line", () => {
  test("a dry run takes any URL; --apply takes only a local one unless the operator says otherwise", () => {
    expect(parseArgs(["--target", "mongodb+srv://user:pw@cluster.example/core"])).toMatchObject({apply: false})
    expect(parseArgs(["--target=mongodb://127.0.0.1:27017/core", "--apply"])).toMatchObject({apply: true})
    expect(() => parseArgs(["--target", "mongodb+srv://user:pw@cluster.example/core", "--apply"])).toThrow(UsageError)
    expect(
      parseArgs(["--target", "mongodb+srv://user:pw@cluster.example/core", "--apply", "--i-understand-remote"]),
    ).toMatchObject({apply: true, allowRemote: true})
  })

  test("refuses a missing, repeated or unknown argument and a URL that is not MongoDB", () => {
    expect(() => parseArgs([])).toThrow("--target is required")
    expect(() => parseArgs(["--target"])).toThrow("--target needs a value")
    expect(() => parseArgs(["--target", "mongodb://127.0.0.1/a", "--target", "mongodb://127.0.0.1/b"])).toThrow("more than once")
    expect(() => parseArgs(["--target", "http://example.test"])).toThrow("mongodb://")
    expect(() => parseArgs(["--target", "mongodb://127.0.0.1/a", "--force"])).toThrow("unknown argument")
  })
})
