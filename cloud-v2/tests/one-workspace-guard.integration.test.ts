/**
 * @fileoverview One workspace per person: the guard, against a real replica set.
 *
 * The rule is atomic. Two accepts of two invitations at the same moment, an accept racing a create, and two
 * creates must leave exactly one membership, and the loser must get `already_in_workspace`. The guard is a
 * document in the memberships collection whose `_id` is derived from the Core user id, so a duplicate-key
 * error is the arbiter and the guard commits with the membership it guards.
 *
 * Also pinned here: the guard's lifecycle (taken at accept, create and ownership recovery; released at leave,
 * removal, workspace deletion and account deletion), the startup initialization (people with one membership
 * get a guard, people with several are refused until cleaned up), and that guard documents never show up in
 * any listing of memberships.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/one-workspace-guard.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import type {Model} from "mongoose"

import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {removeDeletedUserFromWorkspaces} from "../packages/core/src/services/workspaces/account-deletion.service"
import {acceptInvitation, createInvitation} from "../packages/core/src/services/workspaces/invitation.service"
import {
  acquireGuard,
  GUARD_KIND,
  guardIdOf,
  initializeGuards,
  releaseGuard,
} from "../packages/core/src/services/workspaces/membership-guard.service"
import {
  countActiveOwners,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  leaveWorkspace,
  listMembers,
  listWorkspacesForUser,
  recoverOwnership,
  removeMember,
  getWorkspace,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
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

const URL_TEMPLATE = "https://core.example.test/invite/{token}"
const URL_PREFIX = "https://core.example.test/invite/"

let databaseUrl: string
let verified = false
const savedTemplate = process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
const savedAdminEmails = process.env.CLOUD_CORE_ADMIN_EMAILS

type UserActor = Actor & {kind: "user"}

function user(id: string, overrides: Partial<UserActor> = {}): UserActor {
  return {
    kind: "user",
    mentraUserId: id,
    email: `${id}@example.test`,
    emailVerified: true,
    isOrganizationAdmin: false,
    ...overrides,
  }
}

const orgAdmin = user("mu_org_admin", {isOrganizationAdmin: true})

let counter = 0
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

/** An active membership written directly: how a person came to hold several before the guard. */
async function addLegacyMember(workspaceId: string, mentraUserId: string, role: string) {
  const membershipId = `wm_${nextId()}`
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId,
      email: `${mentraUserId}@example.test`,
      role,
      status: "active",
      startedAt: new Date(),
    }),
  )
  return membershipId
}

async function accountOf(mentraUserId: string) {
  await UserModel.create({mentraUserId, tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`})
}

/** The guard document of a person, or null. */
async function guardOf(mentraUserId: string): Promise<Record<string, any> | null> {
  return (await WorkspaceMembershipModel.collection.findOne({_id: guardIdOf(mentraUserId)} as any)) as Record<string, any> | null
}

const guardCount = () => WorkspaceMembershipModel.collection.countDocuments({kind: GUARD_KIND} as any)

/** A workspace owned by `ownerId`, and an invitation of `email` into it: the invitation's token. */
async function invitationInto(ownerId: string, email: string, name = `W ${nextId()}`) {
  const workspaceId = (await createWorkspace(user(ownerId), {name})).workspaceId
  const created = await createInvitation(user(ownerId), workspaceId, {email, role: "member"})
  return {workspaceId, token: created.inviteUrl.slice(URL_PREFIX.length)}
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

async function expectError(fn: () => Promise<unknown>, code: string, status: number) {
  const err = await thrown(fn)
  expect(err).toBeInstanceOf(WorkspaceError)
  expect({code: err.code, status: err.status}).toEqual({code, status})
}

const activeCount = (mentraUserId: string) => WorkspaceMembershipModel.countDocuments({mentraUserId, status: "active"})

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("one-workspace-guard")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (savedTemplate === undefined) delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
  else process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = savedTemplate
  if (savedAdminEmails === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedAdminEmails
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = URL_TEMPLATE
  // `orgAdmin` is an Organization Admin by this allowlist, and has an account.
  process.env.CLOUD_CORE_ADMIN_EMAILS = orgAdmin.email!
  await accountOf(orgAdmin.mentraUserId)
})

describe("taking the guard", () => {
  test("creating a workspace takes the guard, which names the workspace and the membership", async () => {
    const created = await createWorkspace(user("mu_a"), {name: "A"})
    const membership = (await getActiveMembership(created.workspaceId, "mu_a"))!

    expect(await guardOf("mu_a")).toMatchObject({
      kind: GUARD_KIND,
      guardedUserId: "mu_a",
      guardedWorkspaceId: created.workspaceId,
      guardedMembershipId: membership.membershipId,
    })
    expect(await guardCount()).toBe(1)
  })

  test("a person in a workspace cannot create another, nor accept an invitation into another", async () => {
    const mine = (await createWorkspace(user("mu_a"), {name: "Mine"})).workspaceId
    const into = await invitationInto("mu_b", "a@example.test")
    const before = await WorkspaceMembershipModel.countDocuments({})

    await expectError(() => createWorkspace(user("mu_a"), {name: "Second"}), "already_in_workspace", 409)
    await expectError(
      () => acceptInvitation(user("mu_a", {email: "a@example.test"}), into.token),
      "already_in_workspace",
      409,
    )

    expect(await WorkspaceMembershipModel.countDocuments({})).toBe(before)
    expect(await WorkspaceModel.countDocuments({})).toBe(2)
    expect(await activeCount("mu_a")).toBe(1)
    expect((await guardOf("mu_a"))!.guardedWorkspaceId).toBe(mine)
    // The refused invitation is still pending, for after they leave.
    expect(await WorkspaceInvitationModel.countDocuments({workspaceId: into.workspaceId, status: "pending"})).toBe(1)
  })

  test("a member of the invited workspace who accepts again still gets already_member", async () => {
    const into = await invitationInto("mu_b", "b@example.test")
    await acceptInvitation(user("mu_c", {email: "b@example.test"}), into.token)
    const again = await createInvitation(user("mu_b"), into.workspaceId, {email: "c@example.test", role: "member"})
    await expectError(
      () => acceptInvitation(user("mu_c", {email: "c@example.test"}), again.inviteUrl.slice(URL_PREFIX.length)),
      "already_member",
      409,
    )
  })

  test("accepting takes the guard for the new membership", async () => {
    const into = await invitationInto("mu_b", "c@example.test")

    const accepted = await acceptInvitation(user("mu_c", {email: "c@example.test"}), into.token)

    expect(await guardOf("mu_c")).toMatchObject({guardedWorkspaceId: into.workspaceId, guardedMembershipId: accepted.membershipId})
  })

  test("ownership recovery for someone in another workspace is refused, and for someone with none it takes the guard", async () => {
    const target = "mu_target"
    await accountOf(target)
    await accountOf("mu_busy")
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    await createWorkspace(user("mu_busy"), {name: "Busy"})
    const before = await WorkspaceMembershipModel.countDocuments({})

    await expectError(() => recoverOwnership(orgAdmin, ws, "mu_busy"), "already_in_workspace", 409)
    expect(await WorkspaceMembershipModel.countDocuments({})).toBe(before)

    await recoverOwnership(orgAdmin, ws, target)
    expect(await guardOf(target)).toMatchObject({guardedWorkspaceId: ws})
    // Recovering again for the owner they already are changes no guard; an existing member is promoted in place.
    await recoverOwnership(orgAdmin, ws, target)
    expect(await activeCount(target)).toBe(1)
  })

  test("an Organization Admin acting on a workspace without membership takes no guard, and can still make their own", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    await createInvitation(orgAdmin, ws, {email: "x@example.test", role: "member"})
    expect(await guardOf(orgAdmin.mentraUserId)).toBeNull()
    expect(await activeCount(orgAdmin.mentraUserId)).toBe(0)

    await createWorkspace(orgAdmin, {name: "Admin's own"})
    expect(await guardOf(orgAdmin.mentraUserId)).not.toBeNull()
  })

  test("someone with several memberships from before the guard is refused any further join, and has no guard", async () => {
    const a = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    const b = (await createWorkspace(user("mu_b"), {name: "B"})).workspaceId
    await addLegacyMember(a, "mu_multi", "developer")
    await addLegacyMember(b, "mu_multi", "member")
    const into = await invitationInto("mu_c", "multi@example.test")

    await expectError(() => createWorkspace(user("mu_multi"), {name: "No"}), "already_in_workspace", 409)
    await expectError(
      () => acceptInvitation(user("mu_multi", {email: "multi@example.test"}), into.token),
      "already_in_workspace",
      409,
    )
    expect(await guardOf("mu_multi")).toBeNull()
    expect(await activeCount("mu_multi")).toBe(2)

    // Leaving one still leaves them in a workspace; leaving the last frees them.
    await leaveWorkspace(user("mu_multi"), a)
    await expectError(() => createWorkspace(user("mu_multi"), {name: "No"}), "already_in_workspace", 409)
    await leaveWorkspace(user("mu_multi"), b)
    await createWorkspace(user("mu_multi"), {name: "Fine"})
  })
})

describe("under concurrency", () => {
  test("two accepts of two invitations by one person: exactly one wins, the other is already_in_workspace", async () => {
    for (let round = 0; round < 8; round++) {
      const email = `racer${round}@example.test`
      const one = await invitationInto(`mu_o1_${round}`, email)
      const two = await invitationInto(`mu_o2_${round}`, email)

      const results = await Promise.allSettled([
        acceptInvitation(user(`mu_racer${round}`, {email}), one.token),
        acceptInvitation(user(`mu_racer${round}`, {email}), two.token),
      ])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(loser.reason).toMatchObject({code: "already_in_workspace", status: 409})
      expect(await activeCount(`mu_racer${round}`)).toBe(1)
      expect(await guardOf(`mu_racer${round}`)).not.toBeNull()
      // The loser's invitation was not consumed: its transaction rolled back whole.
      expect(await WorkspaceInvitationModel.countDocuments({email, status: "accepted"})).toBe(1)
      expect(await WorkspaceInvitationModel.countDocuments({email, status: "pending"})).toBe(1)
    }
  })

  test("a create racing an accept: exactly one membership", async () => {
    for (let round = 0; round < 8; round++) {
      const email = `cr${round}@example.test`
      const into = await invitationInto(`mu_co_${round}`, email)

      const results = await Promise.allSettled([
        createWorkspace(user(`mu_cr${round}`, {email}), {name: `Mine ${round}`}),
        acceptInvitation(user(`mu_cr${round}`, {email}), into.token),
      ])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(loser.reason).toMatchObject({code: "already_in_workspace", status: 409})
      expect(await activeCount(`mu_cr${round}`)).toBe(1)
    }
  })

  test("two creates by one person: exactly one workspace", async () => {
    for (let round = 0; round < 8; round++) {
      const results = await Promise.allSettled([
        createWorkspace(user(`mu_twice${round}`), {name: "One"}),
        createWorkspace(user(`mu_twice${round}`), {name: "Two"}),
      ])
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "already_in_workspace",
      })
      expect(await activeCount(`mu_twice${round}`)).toBe(1)
    }
    // The workspace the loser began is not left behind.
    expect(await WorkspaceModel.countDocuments({})).toBe(8)
  })

  test("the guard's own insert is the arbiter: a second acquire in a concurrent transaction fails whatever it read", async () => {
    const results = await Promise.allSettled(
      [1, 2].map(n =>
        withTransaction(session =>
          acquireGuard(session, "mu_direct", {workspaceId: `ws_${n}`, membershipId: `wm_${n}`}),
        ),
      ),
    )
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "already_in_workspace",
    })
    expect(await guardCount()).toBe(1)
  })
})

describe("releasing the guard", () => {
  test("leaving releases it, and the person can then accept", async () => {
    const mine = (await createWorkspace(user("mu_a"), {name: "Mine"})).workspaceId
    await createInvitation(user("mu_a"), mine, {email: "m@example.test", role: "owner"})
    const into = await invitationInto("mu_b", "a@example.test")
    // Not the last owner: add a second owner so leaving is allowed.
    await addLegacyMember(mine, "mu_other_owner", "owner")

    await leaveWorkspace(user("mu_a"), mine)
    expect(await guardOf("mu_a")).toBeNull()

    const accepted = await acceptInvitation(user("mu_a", {email: "a@example.test"}), into.token)
    expect(await guardOf("mu_a")).toMatchObject({guardedMembershipId: accepted.membershipId})
  })

  test("being removed releases it", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    const invite = await createInvitation(user("mu_a"), ws, {email: "r@example.test", role: "member"})
    const accepted = await acceptInvitation(user("mu_r", {email: "r@example.test"}), invite.inviteUrl.slice(URL_PREFIX.length))
    expect(await guardOf("mu_r")).not.toBeNull()

    const revision = (await getWorkspace(ws))!.authorizationRevision
    await removeMember(user("mu_a"), ws, accepted.membershipId, revision)

    expect(await guardOf("mu_r")).toBeNull()
    expect(await guardOf("mu_a")).not.toBeNull()
    await createWorkspace(user("mu_r"), {name: "Mine now"})
  })

  test("deleting a workspace releases every member's guard, and no one else's", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "Gone"})).workspaceId
    for (const id of ["mu_m1", "mu_m2"]) {
      const invite = await createInvitation(user("mu_a"), ws, {email: `${id}@example.test`, role: "member"})
      await acceptInvitation(user(id, {email: `${id}@example.test`}), invite.inviteUrl.slice(URL_PREFIX.length))
    }
    await createWorkspace(user("mu_elsewhere"), {name: "Elsewhere"})
    expect(await guardCount()).toBe(4)

    await deleteWorkspace(user("mu_a"), ws, {confirmName: "Gone"})

    expect(await guardOf("mu_a")).toBeNull()
    expect(await guardOf("mu_m1")).toBeNull()
    expect(await guardOf("mu_m2")).toBeNull()
    expect(await guardOf("mu_elsewhere")).not.toBeNull()
    await createWorkspace(user("mu_m1"), {name: "Fresh start"})
  })

  test("deleting an account releases its guard", async () => {
    await accountOf("mu_leaving")
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    const invite = await createInvitation(user("mu_a"), ws, {email: "l@example.test", role: "member"})
    await acceptInvitation(user("mu_leaving", {email: "l@example.test"}), invite.inviteUrl.slice(URL_PREFIX.length))
    expect(await guardOf("mu_leaving")).not.toBeNull()

    await removeDeletedUserFromWorkspaces("mu_leaving")

    expect(await guardOf("mu_leaving")).toBeNull()
    expect(await guardOf("mu_a")).not.toBeNull()
  })

  test("a guard that names another membership of the person is not released by an unrelated one", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    await withTransaction(session => releaseGuard(session, "mu_a", "wm_someone_elses"))
    expect(await guardOf("mu_a")).toMatchObject({guardedWorkspaceId: ws})
  })
})

describe("initializing the guards at startup", () => {
  test("people with one active membership get a guard; people with several, and people with none, do not", async () => {
    const a = (await createWorkspace(user("mu_creator"), {name: "A"})).workspaceId
    const b = (await createWorkspace(user("mu_creator_b"), {name: "B"})).workspaceId
    await WorkspaceMembershipModel.collection.deleteMany({kind: GUARD_KIND} as any)
    const single = await addLegacyMember(a, "mu_single", "developer")
    await addLegacyMember(a, "mu_multi", "developer")
    await addLegacyMember(b, "mu_multi", "member")
    const ended = await addLegacyMember(a, "mu_ended", "developer")
    await WorkspaceMembershipModel.updateOne({membershipId: ended}, {$set: {status: "ended", endedAt: new Date(), endedReason: "left"}})

    const written = await initializeGuards()

    // The two creators' own guards were deleted above and are rewritten with mu_single's.
    expect(written).toBe(3)
    expect(await guardOf("mu_single")).toMatchObject({guardedWorkspaceId: a, guardedMembershipId: single})
    expect(await guardOf("mu_multi")).toBeNull()
    expect(await guardOf("mu_ended")).toBeNull()
    expect(await guardOf("mu_nobody")).toBeNull()
    // Idempotent, and never overwrites.
    expect(await initializeGuards()).toBe(0)
    expect(await guardCount()).toBe(3)
  })

  test("a batch larger than the batch size is written whole", async () => {
    const ws = (await createWorkspace(user("mu_creator"), {name: "A"})).workspaceId
    await WorkspaceMembershipModel.collection.deleteMany({kind: GUARD_KIND} as any)
    for (let i = 0; i < 7; i++) await addLegacyMember(ws, `mu_bulk${i}`, "member")

    expect(await initializeGuards(3)).toBe(8)
    expect(await guardCount()).toBe(8)
  })
})

describe("guard documents are not memberships", () => {
  test("no listing of memberships returns one", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    const invite = await createInvitation(user("mu_a"), ws, {email: "g@example.test", role: "admin"})
    await acceptInvitation(user("mu_g", {email: "g@example.test"}), invite.inviteUrl.slice(URL_PREFIX.length))
    expect(await guardCount()).toBe(2)

    expect((await listMembers(ws)).map(member => member.mentraUserId).sort()).toEqual(["mu_a", "mu_g"])
    expect((await listWorkspacesForUser("mu_g")).map(workspace => workspace.workspaceId)).toEqual([ws])
    expect(await countActiveOwners(ws)).toBe(1)
    expect(await WorkspaceMembershipModel.countDocuments({status: "active"})).toBe(2)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws})).toBe(2)
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: {$type: "string"}})).toBe(2)
    expect(await WorkspaceMembershipModel.countDocuments({role: {$exists: true}})).toBe(2)
    // Their ids never collide with a membership id.
    const guards = await WorkspaceMembershipModel.collection.find({kind: GUARD_KIND} as any).toArray()
    for (const guard of guards) expect(String(guard.membershipId)).not.toMatch(/^wm_/)
  })
})
