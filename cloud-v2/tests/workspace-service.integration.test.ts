/**
 * @fileoverview Workspace lifecycle, membership and role-transition integration tests.
 *
 * These run the real services, models and transactions against a local replica
 * set; nothing is mocked.
 * The interesting cases are the concurrent ones: two owners demoting each other
 * (or leaving) at the same time must leave exactly one owner.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspace-service.integration.test.ts`
 */

import {createHash} from "node:crypto"

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import type {Model} from "mongoose"

import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {runWithRequestId} from "../packages/core/src/services/request-context"
import {
  clampPageSize,
  listWorkspaceAudit,
  recordWorkspaceEvent,
  redactSecrets,
} from "../packages/core/src/services/workspaces/audit.service"
import {validateCredentialToken} from "../packages/core/src/services/workspaces/credential.service"
import {workspaceCreationPolicy} from "../packages/core/src/services/workspaces/organization"
import {
  changeRole,
  countActiveOwners,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  getWorkspace,
  leaveWorkspace,
  listAllWorkspaces,
  listMembers,
  listWorkspacesForUser,
  recoverOwnership,
  removeMember,
  renameWorkspace,
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
  WorkspaceAuditEventModel,
]

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false

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
const system: Actor = {kind: "system"}
const service: Actor = {kind: "service", service: "store", email: null}

let counter = 0
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

/** Add an active membership directly (stands in for the invitation flow). */
async function addMember(
  workspaceId: string,
  mentraUserId: string,
  role: string,
  fields: Record<string, unknown> = {},
) {
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
      ...fields,
    }),
  )
  return membershipId
}

async function membershipIdOf(workspaceId: string, mentraUserId: string): Promise<string> {
  const row = await getActiveMembership(workspaceId, mentraUserId)
  if (!row) throw new Error(`no active membership for ${mentraUserId}`)
  return row.membershipId
}

async function revisionOf(workspaceId: string): Promise<number> {
  const row = await getWorkspace(workspaceId)
  if (!row) throw new Error(`no workspace ${workspaceId}`)
  return row.authorizationRevision
}

async function seedCredential(
  workspaceId: string | null,
  createdByMembershipId: string | null,
  fields: Record<string, unknown> = {},
) {
  const credentialId = `01CRED${nextId()}`.toUpperCase()
  await AccessCredentialModel.create({
    credentialId,
    prefix: "msk",
    credentialKind: "workspace",
    workspaceId,
    name: "key",
    env: "local",
    hash: "a".repeat(64),
    last4: "abcd",
    createdByMembershipId,
    ...fields,
  })
  return credentialId
}

async function revokedAtOf(credentialId: string): Promise<Date | null> {
  const row = await AccessCredentialModel.findOne({credentialId}).lean()
  if (!row) throw new Error(`no credential ${credentialId}`)
  return row.revokedAt ?? null
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

/** Run `fn` with `CLOUD_CORE_WORKSPACE_CREATION` set (or unset for `undefined`), then restore it. */
async function withCreationPolicy<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.CLOUD_CORE_WORKSPACE_CREATION
  try {
    if (value === undefined) delete process.env.CLOUD_CORE_WORKSPACE_CREATION
    else process.env.CLOUD_CORE_WORKSPACE_CREATION = value
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.CLOUD_CORE_WORKSPACE_CREATION
    else process.env.CLOUD_CORE_WORKSPACE_CREATION = saved
  }
}

/** A workspace owned by `owner` (the creator). */
async function newWorkspace(owner: UserActor = user("mu_owner"), name = "Acme") {
  const summary = await createWorkspace(owner, {name})
  return summary.workspaceId
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspace-service")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations are not run here. Transactions cannot create a collection
  // (and the unique indexes are the point), so build both up front.
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

describe("createWorkspace", () => {
  test("creator becomes owner and sees owner capabilities", async () => {
    const creator = user("mu_creator")
    const summary = await createWorkspace(creator, {name: "  Acme Labs  "})

    expect(summary).toEqual({
      workspaceId: expect.stringMatching(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/),
      name: "Acme Labs",
      status: "active",
      authorizationRevision: 0,
    })
    expect(await WorkspaceModel.findOne({workspaceId: summary.workspaceId}).lean()).toMatchObject({
      createdByMentraUserId: "mu_creator",
      deletedAt: null,
    })

    const membership = await getActiveMembership(summary.workspaceId, "mu_creator")
    expect(membership).toMatchObject({
      role: "owner",
      status: "active",
      email: "mu_creator@example.test",
    })
    expect(membership!.membershipId).toMatch(/^wm_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(membership!.roleHistory as unknown).toEqual([
      {role: "owner", from: membership!.startedAt, authorizationRevision: 0},
    ])
    expect(membership).not.toHaveProperty("name")

    const listed = await listWorkspacesForUser("mu_creator")
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      workspaceId: summary.workspaceId,
      name: "Acme Labs",
      membership: {membershipId: membership!.membershipId, role: "owner"},
    })
    expect(listed[0]!.capabilities).toContain("workspace.delete")
    expect(listed[0]!.capabilities).toContain("workspace.roles.managePrivileged")
    expect(listed[0]!.capabilities).toContain("miniapps.publish")

    const audit = await listWorkspaceAudit(summary.workspaceId, {limit: 10})
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: "workspace.created",
      actor: {kind: "user", mentraUserId: "mu_creator", email: "mu_creator@example.test"},
      target: {workspaceId: summary.workspaceId, membershipId: membership!.membershipId},
      after: {name: "Acme Labs", role: "owner"},
      requestId: null,
    })
  })

  test("names are trimmed and must be 1-80 characters (400 invalid_request)", async () => {
    for (const bad of ["", "   ", "x".repeat(81), 42 as unknown as string, undefined as unknown as string]) {
      await expectError(() => createWorkspace(user("mu_a"), {name: bad}), "invalid_request", 400)
    }
    expect((await createWorkspace(user("mu_a"), {name: "x".repeat(80)})).name).toHaveLength(80)
    expect(await WorkspaceModel.countDocuments({})).toBe(1)
  })

  test("an actor without a user id cannot create a workspace (403 forbidden)", async () => {
    const actors = [
      user(""),
      user("   "),
      {...user("mu_x"), mentraUserId: undefined as unknown as string},
      {kind: "system"} as unknown as UserActor,
      service as unknown as UserActor,
    ]
    for (const actor of actors) await expectError(() => createWorkspace(actor, {name: "Nobody"}), "forbidden", 403)
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
    expect(await WorkspaceMembershipModel.countDocuments({})).toBe(0)
  })

  test("an unverified email cannot create a workspace (403 email_unverified), not even an admin's", async () => {
    await expectError(
      () => createWorkspace(user("mu_unverified", {emailVerified: false}), {name: "Nope"}),
      "email_unverified",
      403,
    )
    await expectError(
      () => createWorkspace({...orgAdmin, emailVerified: undefined as unknown as boolean}, {name: "Nope"}),
      "email_unverified",
      403,
    )
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
    expect(await WorkspaceMembershipModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(0)
  })

  test("CLOUD_CORE_WORKSPACE_CREATION=organization-admins limits creation to organization admins", async () => {
    await withCreationPolicy("organization-admins", async () => {
      expect(workspaceCreationPolicy()).toBe("organization-admins")
      await expectError(() => createWorkspace(user("mu_plain"), {name: "Nope"}), "forbidden", 403)
      expect(await WorkspaceModel.countDocuments({})).toBe(0)
      expect(await WorkspaceMembershipModel.countDocuments({})).toBe(0)
      expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(0)
      expect((await createWorkspace(orgAdmin, {name: "Allowed"})).name).toBe("Allowed")
    })
    // The value is read at call time, trimmed and case-insensitive.
    await withCreationPolicy("  Organization-Admins ", async () => {
      expect(workspaceCreationPolicy()).toBe("organization-admins")
      await expectError(() => createWorkspace(user("mu_plain"), {name: "Still no"}), "forbidden", 403)
    })
    await withCreationPolicy("open", async () => {
      expect(workspaceCreationPolicy()).toBe("open")
      expect((await createWorkspace(user("mu_plain"), {name: "Open"})).name).toBe("Open")
    })
    await withCreationPolicy(undefined, async () => {
      expect(workspaceCreationPolicy()).toBe("open")
      expect((await createWorkspace(user("mu_plain"), {name: "Default"})).name).toBe("Default")
    })
    const names = (await WorkspaceModel.find({}).sort({_id: 1}).lean()).map(row => row.name)
    expect(names).toEqual(["Allowed", "Open", "Default"])
  })

  test("an unrecognized CLOUD_CORE_WORKSPACE_CREATION throws instead of opening creation up", async () => {
    for (const typo of ["organization-admin", "admins", "closed", "true"]) {
      await withCreationPolicy(typo, async () => {
        expect(() => workspaceCreationPolicy()).toThrow("CLOUD_CORE_WORKSPACE_CREATION")
        for (const actor of [user("mu_plain"), orgAdmin]) {
          const err = await thrown(() => createWorkspace(actor, {name: "Typo"}))
          // A configuration fault, not a client error.
          expect(err).not.toBeInstanceOf(WorkspaceError)
          expect(err.message).toContain("CLOUD_CORE_WORKSPACE_CREATION")
        }
      })
    }
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
    expect(await WorkspaceMembershipModel.countDocuments({})).toBe(0)
  })
})

describe("deleted accounts", () => {
  /** What account deletion does first: the users row becomes a tombstone. */
  async function deleteAccount(mentraUserId: string) {
    await UserModel.updateOne(
      {mentraUserId},
      {$set: {supportTelemetryDeletedAt: new Date()}, $setOnInsert: {tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`}},
      {upsert: true},
    )
  }

  test("a deleted account cannot create a workspace (account_deleted), and nothing is written", async () => {
    await deleteAccount("mu_gone")
    await expectError(() => createWorkspace(user("mu_gone"), {name: "Ghost"}), "account_deleted", 403)
    expect(await WorkspaceModel.countDocuments({name: "Ghost"})).toBe(0)
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: "mu_gone"})).toBe(0)
  })

  test("a deleted account's owner membership can always be removed or demoted, with one live owner left", async () => {
    const ws = await newWorkspace()
    const demoted = await addMember(ws, "mu_gone_a", "owner")
    const removed = await addMember(ws, "mu_gone_b", "owner")
    await deleteAccount("mu_gone_a")
    await deleteAccount("mu_gone_b")
    expect(await countActiveOwners(ws)).toBe(1)

    // Demoting one is not demoting the last live owner.
    await changeRole(user("mu_owner"), ws, demoted, "admin", 0)
    expect((await getActiveMembership(ws, "mu_gone_a"))!.role).toBe("admin")
    // Removing one is not removing the last live owner either.
    await removeMember(user("mu_owner"), ws, removed, 1)
    expect(await getActiveMembership(ws, "mu_gone_b")).toBeNull()
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("owner")
    expect(await countActiveOwners(ws)).toBe(1)
  })

  test("the last-owner guard never counts a deleted account's owner membership", async () => {
    const ws = await newWorkspace()
    // An owner membership of a deleted account, as a failed deletion could leave behind.
    await addMember(ws, "mu_gone", "owner")
    await deleteAccount("mu_gone")
    expect(await countActiveOwners(ws)).toBe(1)

    const ownerId = (await getActiveMembership(ws, "mu_owner"))!.membershipId
    await expectError(() => leaveWorkspace(user("mu_owner"), ws), "last_owner", 409)
    await expectError(() => changeRole(user("mu_owner"), ws, ownerId, "admin", 0), "last_owner", 409)
    await expectError(() => removeMember(orgAdmin, ws, ownerId, 0), "last_owner", 409)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("owner")

    // A live second owner still counts.
    await addMember(ws, "mu_owner2", "owner")
    expect(await countActiveOwners(ws)).toBe(2)
    await leaveWorkspace(user("mu_owner"), ws)
    expect(await countActiveOwners(ws)).toBe(1)
  })
})

describe("memberships imported from the Store, pending their person's first sign-in", () => {
  /** A membership imported under a WorkOS user id, with no Core user yet. */
  async function addPending(workspaceId: string, workosUserId: string, role: string, fields: Record<string, unknown> = {}) {
    return addMember(workspaceId, "unused", role, {
      mentraUserId: null,
      pendingWorkosUserId: workosUserId,
      email: `${workosUserId}@example.test`,
      ...fields,
    })
  }

  test("are listed with the other members, and count as owners for the last-owner guard", async () => {
    const ws = await newWorkspace()
    const pendingOwner = await addPending(ws, "user_owner", "owner")
    await addPending(ws, "user_dev", "developer")

    expect((await listMembers(ws)).map(row => [row.mentraUserId ?? null, row.pendingWorkosUserId ?? null, row.role])).toEqual([
      ["mu_owner", null, "owner"],
      [null, "user_owner", "owner"],
      [null, "user_dev", "developer"],
    ])
    // Someone holds that ownership and claims it at their first sign-in.
    expect(await countActiveOwners(ws)).toBe(2)
    // So the signed-in owner may leave: the pending owner remains.
    await leaveWorkspace(user("mu_owner"), ws)
    expect(await countActiveOwners(ws)).toBe(1)

    // A pending owner who is the last owner is guarded like any other.
    const revision = await revisionOf(ws)
    await expectError(() => removeMember(orgAdmin, ws, pendingOwner, revision), "last_owner", 409)
    await expectError(() => changeRole(orgAdmin, ws, pendingOwner, "admin", revision), "last_owner", 409)
    expect(await countActiveOwners(ws)).toBe(1)
  })

  test("an admin changes a pending member's role and removes them, with their keys, audited without a user id", async () => {
    const ws = await newWorkspace()
    const admin = user("mu_admin")
    await addMember(ws, "mu_admin", "admin")
    const pending = await addPending(ws, "user_dev", "developer")
    const key = await seedCredential(ws, pending)

    await changeRole(admin, ws, pending, "member", await revisionOf(ws))
    const changed = (await WorkspaceMembershipModel.findOne({membershipId: pending}).lean())!
    expect(changed).toMatchObject({role: "member", mentraUserId: null, pendingWorkosUserId: "user_dev"})
    expect(changed.roleHistory.map(entry => entry.role)).toEqual(["developer", "member"])

    await removeMember(admin, ws, pending, await revisionOf(ws))
    expect(await WorkspaceMembershipModel.findOne({membershipId: pending}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    expect(await revokedAtOf(key)).toBeInstanceOf(Date)
    const events = await WorkspaceAuditEventModel.find({workspaceId: ws, "target.membershipId": pending})
      .sort({eventId: 1})
      .lean()
    expect(events.map(event => [event.action, event.target])).toEqual([
      ["membership.role_changed", {membershipId: pending, mentraUserId: null, email: "user_dev@example.test"}],
      ["membership.removed", {membershipId: pending, mentraUserId: null, email: "user_dev@example.test"}],
    ])
  })

  test("a key created by a pending membership validates until the membership ends", async () => {
    const ws = await newWorkspace()
    const pending = await addPending(ws, "user_dev", "developer")
    const secret = "s".repeat(43)
    const credentialId = "01HZPEND1NGKEY000000000000"
    await AccessCredentialModel.create({
      credentialId,
      prefix: "msk",
      credentialKind: "workspace",
      workspaceId: ws,
      name: "CI",
      env: "local",
      hash: createHash("sha256").update(secret).digest("hex"),
      last4: secret.slice(-4),
      scopes: ["miniapps.publish"],
      createdByMembershipId: pending,
    })
    const token = `msk_local_${credentialId}.${secret}`
    const saved = process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
    process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "local"
    try {
      expect(await validateCredentialToken(token)).toMatchObject({workspaceId: ws, scopes: ["miniapps.publish"]})
      await removeMember(orgAdmin, ws, pending, await revisionOf(ws))
      expect(await validateCredentialToken(token)).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
      else process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = saved
    }
  })
})

describe("changeRole", () => {
  test("admin promotes member to developer; cannot grant admin (403 forbidden)", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_admin", "admin")
    const memberId = await addMember(ws, "mu_member", "member")
    const adminId = await membershipIdOf(ws, "mu_admin")
    const admin = user("mu_admin")

    const promoted = await changeRole(admin, ws, memberId, "developer", await revisionOf(ws))
    expect(promoted.authorizationRevision).toBe(1)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")

    await expectError(() => changeRole(admin, ws, memberId, "admin", 1), "forbidden", 403)
    await expectError(() => changeRole(admin, ws, memberId, "owner", 1), "forbidden", 403)
    // Admin-or-owner on either side is owner-only: an admin cannot demote another admin either.
    await addMember(ws, "mu_admin2", "admin")
    const admin2Id = await membershipIdOf(ws, "mu_admin2")
    await expectError(() => changeRole(admin, ws, admin2Id, "member", 1), "forbidden", 403)
    await expectError(() => changeRole(admin, ws, adminId, "member", 1), "forbidden", 403)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")
    expect(await revisionOf(ws)).toBe(1)

    // The owner can grant admin.
    const ownerGrant = await changeRole(user("mu_owner"), ws, memberId, "admin", 1)
    expect(ownerGrant.authorizationRevision).toBe(2)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("admin")

    // Each change appended a role interval at the revision it produced; refused changes appended nothing.
    const history = (await getActiveMembership(ws, "mu_member"))!.roleHistory
    expect(history.map(entry => [entry.role, entry.authorizationRevision])).toEqual([
      ["member", 0],
      ["developer", 1],
      ["admin", 2],
    ])
    expect(history[1]!.from.getTime()).toBeLessThanOrEqual(history[2]!.from.getTime())
    // The role and the last history entry always agree.
    expect(history.at(-1)!.role).toBe("admin")
  })

  test("changing to the same role appends nothing", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await changeRole(user("mu_owner"), ws, memberId, "member", await revisionOf(ws))

    expect((await getActiveMembership(ws, "mu_member"))!.roleHistory).toHaveLength(1)
  })

  test("a role change is audited with before and after and bumps the revision once", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)

    const events = await listWorkspaceAudit(ws, {limit: 10})
    expect(events[0]).toMatchObject({
      action: "membership.role_changed",
      actor: {kind: "user", mentraUserId: "mu_owner"},
      target: {membershipId: memberId, mentraUserId: "mu_member", email: "mu_member@example.test"},
      before: {role: "member"},
      after: {role: "developer"},
    })
    expect(await revisionOf(ws)).toBe(1)
  })

  test("owner cannot demote themselves when they are the last owner (409 last_owner)", async () => {
    const ws = await newWorkspace()
    const ownerId = await membershipIdOf(ws, "mu_owner")

    await expectError(() => changeRole(user("mu_owner"), ws, ownerId, "admin", 0), "last_owner", 409)
    // An organization admin cannot leave a workspace ownerless either.
    await expectError(() => changeRole(orgAdmin, ws, ownerId, "member", 0), "last_owner", 409)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("owner")
    expect((await getActiveMembership(ws, "mu_owner"))!.roleHistory).toHaveLength(1)
    expect(await revisionOf(ws)).toBe(0)

    // With a second owner, the same demotion goes through.
    await addMember(ws, "mu_owner2", "owner")
    await changeRole(user("mu_owner"), ws, ownerId, "admin", 0)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("admin")
    expect(await countActiveOwners(ws)).toBe(1)
    // Now mu_owner2 is the last owner.
    const owner2Id = await membershipIdOf(ws, "mu_owner2")
    await expectError(() => changeRole(user("mu_owner2"), ws, owner2Id, "admin", 1), "last_owner", 409)
  })

  test("concurrent demotions of two owners: exactly one fails", async () => {
    for (let round = 0; round < 5; round++) {
      const a = user(`mu_a${round}`)
      const b = user(`mu_b${round}`)
      const ws = await newWorkspace(a, `Race ${round}`)
      const mA = await membershipIdOf(ws, a.mentraUserId)
      const mB = await addMember(ws, b.mentraUserId, "owner")
      const r = await revisionOf(ws)

      const results = await Promise.allSettled([changeRole(a, ws, mB, "admin", r), changeRole(b, ws, mA, "admin", r)])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(rejected.reason).toBeInstanceOf(WorkspaceError)
      expect({code: rejected.reason.code, status: rejected.reason.status}).toEqual({
        code: "membership_changed",
        status: 409,
      })
      expect(await countActiveOwners(ws)).toBe(1)
      // Exactly one transition was recorded and the revision moved once.
      expect(await revisionOf(ws)).toBe(r + 1)
      expect(
        await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.role_changed"}),
      ).toBe(1)
      // Only the demoted owner's history grew.
      const histories = await WorkspaceMembershipModel.find({workspaceId: ws}).lean()
      expect(histories.map(row => row.roleHistory.length).sort()).toEqual([1, 2])
    }
  })

  test("stale expectedRevision returns 409 membership_changed", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)

    await expectError(() => changeRole(user("mu_owner"), ws, memberId, "member", 0), "membership_changed", 409)
    await expectError(() => changeRole(user("mu_owner"), ws, memberId, "member", 7), "membership_changed", 409)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")
    expect((await getActiveMembership(ws, "mu_member"))!.roleHistory).toHaveLength(2)
    expect(await revisionOf(ws)).toBe(1)
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.role_changed"})).toBe(1)
  })

  test("organization admins and the system act as owner; service actors and non-members cannot", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    // An organization admin with no membership grants admin.
    await changeRole(orgAdmin, ws, memberId, "admin", 0)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("admin")
    // The system actor too.
    await changeRole(system, ws, memberId, "developer", 1)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]!.actor).toEqual({kind: "system"})

    await expectError(() => changeRole(service, ws, memberId, "member", 2), "forbidden", 403)
    await expectError(() => changeRole(user("mu_stranger"), ws, memberId, "member", 2), "forbidden", 403)
    // A plain member (no membership management) cannot either.
    await addMember(ws, "mu_plain", "member")
    await expectError(() => changeRole(user("mu_plain"), ws, memberId, "member", 2), "forbidden", 403)
    // A developer neither.
    await expectError(() => changeRole(user("mu_member"), ws, memberId, "member", 2), "forbidden", 403)
    expect(await revisionOf(ws)).toBe(2)
  })

  test("unknown roles, unknown memberships and other workspaces' memberships are rejected", async () => {
    const ws = await newWorkspace()
    const other = await newWorkspace(user("mu_other_owner"), "Other")
    const memberId = await addMember(ws, "mu_member", "member")
    const foreignId = await membershipIdOf(other, "mu_other_owner")

    await expectError(() => changeRole(user("mu_owner"), ws, memberId, "superuser" as never, 0), "invalid_role", 400)
    await expectError(() => changeRole(user("mu_owner"), ws, "wm_missing", "admin", 0), "not_found", 404)
    await expectError(() => changeRole(user("mu_owner"), ws, foreignId, "member", 0), "not_found", 404)
    await expectError(() => changeRole(user("mu_owner"), "ws_missing", memberId, "admin", 0), "not_found", 404)
    expect(await revisionOf(ws)).toBe(0)
    expect(await revisionOf(other)).toBe(0)
  })

  test("setting the role a member already has changes nothing", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    const summary = await changeRole(user("mu_owner"), ws, memberId, "member", 0)

    expect(summary.authorizationRevision).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.role_changed"})).toBe(0)
  })
})

describe("removeMember", () => {
  test("removing a member ends the row, revokes their credentials, and rejoin creates a new membershipId", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "developer")
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const memberKeys = [await seedCredential(ws, memberId), await seedCredential(ws, memberId)]
    const ownerKey = await seedCredential(ws, ownerId)
    const alreadyRevoked = await seedCredential(ws, memberId)
    const earlier = new Date("2026-01-01T00:00:00Z")
    await AccessCredentialModel.updateOne({credentialId: alreadyRevoked}, {$set: {revokedAt: earlier}})
    const elsewhere = await newWorkspace(user("mu_x"), "Elsewhere")
    const unrelatedKey = await seedCredential(elsewhere, null)

    const summary = await removeMember(user("mu_owner"), ws, memberId, 0)

    expect(summary.authorizationRevision).toBe(1)
    expect(await getActiveMembership(ws, "mu_member")).toBeNull()
    const ended = await WorkspaceMembershipModel.findOne({membershipId: memberId}).lean()
    expect(ended).toMatchObject({status: "ended", endedReason: "removed", role: "developer"})
    expect(ended!.endedAt).toBeInstanceOf(Date)
    // Ending closes the last role interval at endedAt; nothing is appended.
    expect(ended!.roleHistory).toHaveLength(1)

    for (const id of memberKeys) expect(await revokedAtOf(id)).toBeInstanceOf(Date)
    expect(await revokedAtOf(ownerKey)).toBeNull()
    expect(await revokedAtOf(unrelatedKey)).toBeNull()
    // A credential that was already revoked keeps its original revocation time.
    expect(await revokedAtOf(alreadyRevoked)).toEqual(earlier)
    const revokedAtByKey = async () =>
      Object.fromEntries(
        (await AccessCredentialModel.find({credentialId: {$in: [...memberKeys, alreadyRevoked]}}).lean()).map(row => [
          row.credentialId,
          row.revokedAt,
        ]),
      )
    const revokedAtBeforeRejoin = await revokedAtByKey()

    const events = await listWorkspaceAudit(ws, {limit: 10})
    expect(events[0]).toMatchObject({
      action: "membership.removed",
      actor: {kind: "user", mentraUserId: "mu_owner"},
      target: {membershipId: memberId, mentraUserId: "mu_member", email: "mu_member@example.test"},
      before: {role: "developer", status: "active"},
      after: {status: "ended", endedReason: "removed"},
    })
    expect([...events[0]!.after.revokedCredentialIds].sort()).toEqual([...memberKeys].sort())

    // Rejoin: a new generation under a new membershipId; the old row stays as history.
    const rejoinId = await addMember(ws, "mu_member", "member")
    expect(rejoinId).not.toBe(memberId)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, mentraUserId: "mu_member"})).toBe(2)
    expect((await getActiveMembership(ws, "mu_member"))!.membershipId).toBe(rejoinId)
    expect((await WorkspaceMembershipModel.findOne({membershipId: memberId}).lean())!.status).toBe("ended")
    // Rejoining must not bring the old keys back: they stay revoked, at the same instant as before.
    const revokedAtAfterRejoin = await revokedAtByKey()
    expect(revokedAtAfterRejoin).toEqual(revokedAtBeforeRejoin)
    for (const id of [...memberKeys, alreadyRevoked]) expect(revokedAtAfterRejoin[id]).toBeInstanceOf(Date)
    expect(await AccessCredentialModel.countDocuments({workspaceId: ws, revokedAt: null})).toBe(1) // the owner's key
  })

  test("the last owner cannot be removed, and removing a privileged member is owner-only", async () => {
    const ws = await newWorkspace()
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const adminId = await addMember(ws, "mu_admin", "admin")
    await addMember(ws, "mu_admin2", "admin")
    const developerId = await addMember(ws, "mu_dev", "developer")

    await expectError(() => removeMember(user("mu_owner"), ws, ownerId, 0), "last_owner", 409)
    await expectError(() => removeMember(orgAdmin, ws, ownerId, 0), "last_owner", 409)
    await expectError(() => removeMember(system, ws, ownerId, 0), "last_owner", 409)
    // An admin may remove a developer but not another admin.
    await expectError(() => removeMember(user("mu_admin2"), ws, adminId, 0), "forbidden", 403)
    await removeMember(user("mu_admin2"), ws, developerId, 0)
    expect(await getActiveMembership(ws, "mu_dev")).toBeNull()
    // Services cannot mutate memberships.
    await expectError(() => removeMember(service, ws, adminId, 1), "forbidden", 403)
    await removeMember(user("mu_owner"), ws, adminId, 1)
    expect(await getActiveMembership(ws, "mu_admin")).toBeNull()
    expect(await revisionOf(ws)).toBe(2)
    expect(await countActiveOwners(ws)).toBe(1)
  })

  test("a second owner can be removed while another owner remains", async () => {
    const ws = await newWorkspace()
    const owner2Id = await addMember(ws, "mu_owner2", "owner")

    await removeMember(user("mu_owner"), ws, owner2Id, 0)

    expect(await countActiveOwners(ws)).toBe(1)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("owner")
  })

  test("a stale revision or an already-ended membership does not remove anything", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await expectError(() => removeMember(user("mu_owner"), ws, memberId, 3), "membership_changed", 409)
    expect(await getActiveMembership(ws, "mu_member")).not.toBeNull()
    await removeMember(user("mu_owner"), ws, memberId, 0)
    await expectError(() => removeMember(user("mu_owner"), ws, memberId, 1), "not_found", 404)
    expect(await revisionOf(ws)).toBe(1)
  })
})

describe("leaveWorkspace", () => {
  test("a member leaves (endedReason left) and their credentials are revoked", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "developer")
    const key = await seedCredential(ws, memberId)

    await leaveWorkspace(user("mu_member"), ws)

    expect(await getActiveMembership(ws, "mu_member")).toBeNull()
    expect(await WorkspaceMembershipModel.findOne({membershipId: memberId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "left",
    })
    expect(await revokedAtOf(key)).toBeInstanceOf(Date)
    expect(await revisionOf(ws)).toBe(1)
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.left",
      actor: {kind: "user", mentraUserId: "mu_member"},
      target: {membershipId: memberId, mentraUserId: "mu_member", email: "mu_member@example.test"},
      after: {status: "ended", endedReason: "left", revokedCredentialIds: [key]},
    })
    expect(await listWorkspacesForUser("mu_member")).toEqual([])
  })

  test("the last owner cannot leave; a non-member has nothing to leave", async () => {
    const ws = await newWorkspace()

    await expectError(() => leaveWorkspace(user("mu_owner"), ws), "last_owner", 409)
    await expectError(() => leaveWorkspace(user("mu_stranger"), ws), "not_found", 404)
    await expectError(() => leaveWorkspace(user(""), ws), "not_found", 404)
    await expectError(() => leaveWorkspace(user("mu_owner"), "ws_missing"), "not_found", 404)
    expect(await countActiveOwners(ws)).toBe(1)
    expect(await revisionOf(ws)).toBe(0)

    await addMember(ws, "mu_owner2", "owner")
    await leaveWorkspace(user("mu_owner"), ws)
    expect(await countActiveOwners(ws)).toBe(1)
    // The remaining owner is now the last one.
    await expectError(() => leaveWorkspace(user("mu_owner2"), ws), "last_owner", 409)
  })

  test("both owners leaving at once: exactly one leaves", async () => {
    for (let round = 0; round < 5; round++) {
      const a = user(`mu_la${round}`)
      const b = user(`mu_lb${round}`)
      const ws = await newWorkspace(a, `Leave ${round}`)
      await addMember(ws, b.mentraUserId, "owner")

      const results = await Promise.allSettled([leaveWorkspace(a, ws), leaveWorkspace(b, ws)])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(rejected.reason).toBeInstanceOf(WorkspaceError)
      expect({code: rejected.reason.code, status: rejected.reason.status}).toEqual({code: "last_owner", status: 409})
      expect(await countActiveOwners(ws)).toBe(1)
      expect(await revisionOf(ws)).toBe(1)
      expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.left"})).toBe(1)
    }
  })

  test("an owner leaving while another owner demotes them: exactly one owner remains", async () => {
    for (let round = 0; round < 5; round++) {
      const a = user(`mu_da${round}`)
      const b = user(`mu_db${round}`)
      const ws = await newWorkspace(a, `Mixed ${round}`)
      const mA = await membershipIdOf(ws, a.mentraUserId)
      await addMember(ws, b.mentraUserId, "owner")
      const r = await revisionOf(ws)

      // b leaves while b demotes a: whichever commits first, the other must not leave the workspace ownerless.
      const results = await Promise.allSettled([leaveWorkspace(b, ws), changeRole(b, ws, mA, "member", r)])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(rejected.reason).toBeInstanceOf(WorkspaceError)
      expect(["last_owner", "membership_changed"]).toContain(rejected.reason.code)
      expect(await countActiveOwners(ws)).toBe(1)
      expect(await revisionOf(ws)).toBe(r + 1)
    }
  })
})

/** Core users rows, as signing in creates them: ownership recovery names an existing account. */
async function accounts(...mentraUserIds: string[]) {
  await UserModel.insertMany(
    mentraUserIds.map(mentraUserId => ({mentraUserId, tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`})),
  )
}

describe("recoverOwnership", () => {
  test("organization admin recovers ownership of a workspace whose owners all left", async () => {
    await accounts("mu_new_owner")
    const ws = await newWorkspace()
    await addMember(ws, "mu_owner2", "owner")
    await leaveWorkspace(user("mu_owner"), ws)
    await WorkspaceMembershipModel.updateOne(
      {workspaceId: ws, mentraUserId: "mu_owner2"},
      {$set: {status: "ended", endedReason: "left", endedAt: new Date()}},
    )
    expect(await countActiveOwners(ws)).toBe(0)
    const before = await revisionOf(ws)

    const summary = await recoverOwnership(orgAdmin, ws, "mu_new_owner")

    expect(summary.authorizationRevision).toBe(before + 1)
    expect(await countActiveOwners(ws)).toBe(1)
    const membership = await getActiveMembership(ws, "mu_new_owner")
    expect(membership).toMatchObject({role: "owner", status: "active"})
    expect(membership!.membershipId).toMatch(/^wm_/)
    // A new membership starts its history with the owner role, at the revision recovery produced.
    expect(membership!.roleHistory as unknown).toEqual([
      {role: "owner", from: membership!.startedAt, authorizationRevision: before + 1},
    ])
    expect((await listWorkspacesForUser("mu_new_owner"))[0]!.membership.role).toBe("owner")
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.ownership_recovered",
      actor: {kind: "user", mentraUserId: "mu_org_admin"},
      // Named by id only, a new membership has no address to show.
      target: {membershipId: membership!.membershipId, mentraUserId: "mu_new_owner", email: null},
      before: {role: null},
      after: {role: "owner"},
    })
  })

  test("an existing member is promoted to owner in place, with the promotion appended to their history", async () => {
    await accounts("mu_member")
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await recoverOwnership(system, ws, "  mu_member ")

    const membership = await getActiveMembership(ws, "mu_member")
    expect(membership).toMatchObject({membershipId: memberId, role: "owner"})
    expect(membership!.roleHistory.map(entry => [entry.role, entry.authorizationRevision])).toEqual([
      ["member", 0],
      ["owner", 1],
    ])
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, mentraUserId: "mu_member"})).toBe(1)
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.ownership_recovered",
      actor: {kind: "system"},
      // An existing membership keeps, and the event names, the address it records.
      target: {membershipId: memberId, mentraUserId: "mu_member", email: "mu_member@example.test"},
      before: {role: "member"},
      after: {role: "owner"},
    })
  })

  test("someone who is already an owner is left alone", async () => {
    await accounts("mu_owner")
    const ws = await newWorkspace()

    const summary = await recoverOwnership(orgAdmin, ws, "mu_owner")

    expect(summary.authorizationRevision).toBe(0)
    expect((await getActiveMembership(ws, "mu_owner"))!.roleHistory).toHaveLength(1)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.ownership_recovered"})).toBe(0)
  })

  test("a person whose earlier membership ended gets a new generation, not the old row back", async () => {
    await accounts("mu_back")
    const ws = await newWorkspace()
    const oldId = await addMember(ws, "mu_back", "admin")
    await removeMember(user("mu_owner"), ws, oldId, 0)

    await recoverOwnership(orgAdmin, ws, "mu_back")

    const current = await getActiveMembership(ws, "mu_back")
    expect(current!.membershipId).not.toBe(oldId)
    expect(current!.role).toBe("owner")
    expect(await WorkspaceMembershipModel.findOne({membershipId: oldId}).lean()).toMatchObject({
      status: "ended",
      role: "admin",
      endedReason: "removed",
    })
  })

  test("concurrent recoveries for one person create one membership", async () => {
    await accounts("mu_target")
    const ws = await newWorkspace()

    const results = await Promise.allSettled([
      recoverOwnership(orgAdmin, ws, "mu_target"),
      recoverOwnership(system, ws, "mu_target"),
      recoverOwnership(orgAdmin, ws, "mu_target"),
    ])

    expect(results.every(result => result.status === "fulfilled")).toBe(true)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, mentraUserId: "mu_target"})).toBe(1)
    expect(await countActiveOwners(ws)).toBe(2)
    expect(await revisionOf(ws)).toBe(1)
    expect(
      await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.ownership_recovered"}),
    ).toBe(1)
  })

  test("only organization admins and the system may recover ownership", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_admin", "admin")

    await expectError(() => recoverOwnership(user("mu_owner"), ws, "mu_x"), "forbidden", 403)
    await expectError(() => recoverOwnership(user("mu_admin"), ws, "mu_x"), "forbidden", 403)
    await expectError(() => recoverOwnership(service, ws, "mu_x"), "forbidden", 403)
    await expectError(() => recoverOwnership(orgAdmin, ws, "  "), "invalid_request", 400)
    await expectError(() => recoverOwnership(orgAdmin, "ws_missing", "mu_x"), "not_found", 404)
    expect(await getActiveMembership(ws, "mu_x")).toBeNull()
    expect(await revisionOf(ws)).toBe(0)
  })

  test("an id that names no account, or a deleted account's tombstone, is user_not_found and changes nothing", async () => {
    const ws = await newWorkspace()
    await accounts("mu_deleted")
    // Account deletion keeps the users row as a tombstone.
    await UserModel.updateOne({mentraUserId: "mu_deleted"}, {$set: {supportTelemetryDeletedAt: new Date()}})
    const before = await revisionOf(ws)

    for (const target of ["mu_nobody", "mu_deleted"]) {
      await expectError(() => recoverOwnership(orgAdmin, ws, target), "user_not_found", 404)
      await expectError(() => recoverOwnership(system, ws, target), "user_not_found", 404)
      expect(await getActiveMembership(ws, target)).toBeNull()
    }
    expect(await revisionOf(ws)).toBe(before)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.ownership_recovered"})).toBe(0)
  })
})

describe("deleteWorkspace", () => {
  test("delete refuses a confirmName that does not match, and deletes on the exact name", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")

    for (const wrong of ["acme", " Acme", "Acme ", ""]) {
      await expectError(() => deleteWorkspace(user("mu_owner"), ws, {confirmName: wrong}), "invalid_request", 400)
    }
    expect((await getWorkspace(ws))!.status).toBe("active")
    expect(await getActiveMembership(ws, "mu_owner")).not.toBeNull()
    expect(await revisionOf(ws)).toBe(0)

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})
    expect((await getWorkspace(ws))!.status).toBe("deleted")
  })

  test("only an owner or an organization admin may delete", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    await addMember(ws, "mu_admin", "admin")
    const opts = {confirmName: "Acme"}

    await expectError(() => deleteWorkspace(user("mu_admin"), ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(user("mu_stranger"), ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(service, ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(user("mu_owner"), "ws_missing", opts), "not_found", 404)
    expect((await getWorkspace(ws))!.status).toBe("active")

    await deleteWorkspace(orgAdmin, ws, opts)
    expect((await getWorkspace(ws))!.status).toBe("deleted")
  })

  test("deleting ends every membership, revokes every credential and pending invitation, and audits", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    const memberId = await addMember(ws, "mu_member", "member")
    const adminId = await addMember(ws, "mu_admin", "admin")
    const leftAt = new Date("2026-01-01T00:00:00Z")
    const formerId = await addMember(ws, "mu_former", "developer", {
      status: "ended",
      endedReason: "left",
      endedAt: leftAt,
    })
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const creds = [
      await seedCredential(ws, ownerId),
      await seedCredential(ws, memberId),
      await seedCredential(ws, null),
    ]
    const earlier = new Date("2026-02-01T00:00:00Z")
    const alreadyRevoked = await seedCredential(ws, memberId, {revokedAt: earlier})
    const elsewhere = await newWorkspace(user("mu_x"), "Elsewhere")
    const unrelatedKey = await seedCredential(elsewhere, null)
    const operatorKey = await seedCredential(null, null, {prefix: "mak", credentialKind: "organization"})
    const invite = (invitationId: string, email: string, status: string, workspaceId = ws) =>
      WorkspaceInvitationModel.create({
        invitationId,
        workspaceId,
        email,
        role: "member",
        tokenHash: "b".repeat(64),
        status,
        invitedByAuthority: "system",
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    await invite("winv_pending", "p@example.test", "pending")
    await invite("winv_pending2", "q@example.test", "pending")
    await invite("winv_accepted", "a@example.test", "accepted")
    await invite("winv_revoked", "r@example.test", "revoked")
    await invite("winv_elsewhere", "p@example.test", "pending", elsewhere)
    const before = await revisionOf(ws)

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})

    const deleted = await WorkspaceModel.findOne({workspaceId: ws}).lean()
    expect(deleted).toMatchObject({status: "deleted", name: "Acme", authorizationRevision: before + 1})
    expect(deleted!.deletedAt).toBeInstanceOf(Date)
    expect(await countActiveOwners(ws)).toBe(0)
    expect(await listMembers(ws)).toEqual([])

    // Every active membership ended with workspace_deleted; the one that had already ended keeps its reason and time.
    const rows = await WorkspaceMembershipModel.find({workspaceId: ws}).lean()
    expect(rows).toHaveLength(4)
    const active = rows.filter(row => row.membershipId !== formerId)
    expect(active.map(row => row.membershipId).sort()).toEqual([memberId, adminId, ownerId].sort())
    for (const row of active) {
      expect(row).toMatchObject({status: "ended", endedReason: "workspace_deleted"})
      expect(row.endedAt).toEqual(deleted!.deletedAt)
    }
    expect(rows.find(row => row.membershipId === formerId)).toMatchObject({
      status: "ended",
      endedReason: "left",
      endedAt: leftAt,
    })

    for (const id of creds) expect(await revokedAtOf(id)).toEqual(deleted!.deletedAt ?? null)
    expect(await revokedAtOf(alreadyRevoked)).toEqual(earlier)
    expect(await revokedAtOf(unrelatedKey)).toBeNull()
    expect(await revokedAtOf(operatorKey)).toBeNull()

    const statusOf = async (invitationId: string) =>
      (await WorkspaceInvitationModel.findOne({invitationId}).lean())!.status
    expect(await statusOf("winv_pending")).toBe("revoked")
    expect(await statusOf("winv_pending2")).toBe("revoked")
    expect(await statusOf("winv_accepted")).toBe("accepted")
    expect(await statusOf("winv_revoked")).toBe("revoked")
    expect(await statusOf("winv_elsewhere")).toBe("pending")
    expect((await getWorkspace(elsewhere))!.status).toBe("active")
    expect(await getActiveMembership(elsewhere, "mu_x")).not.toBeNull()

    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "workspace.deleted",
      actor: {kind: "user", mentraUserId: "mu_owner"},
      target: {workspaceId: ws},
      before: {name: "Acme", status: "active"},
      after: {status: "deleted"},
    })
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "workspace.deleted"})).toBe(1)
    expect(await listWorkspacesForUser("mu_owner")).toEqual([])
    expect(await listWorkspacesForUser("mu_member")).toEqual([])
    expect(await listWorkspacesForUser("mu_admin")).toEqual([])
  })

  test("a deleted workspace refuses every further change (410 workspace_deleted)", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    const memberId = await addMember(ws, "mu_member", "member")
    await deleteWorkspace(system, ws, {confirmName: "Acme"})
    const r = await revisionOf(ws)

    await expectError(() => changeRole(orgAdmin, ws, memberId, "admin", r), "workspace_deleted", 410)
    await expectError(() => removeMember(orgAdmin, ws, memberId, r), "workspace_deleted", 410)
    await expectError(() => renameWorkspace(orgAdmin, ws, "New", r), "workspace_deleted", 410)
    await expectError(() => recoverOwnership(orgAdmin, ws, "mu_x"), "workspace_deleted", 410)
    await expectError(() => leaveWorkspace(user("mu_member"), ws), "workspace_deleted", 410)
    await expectError(() => deleteWorkspace(orgAdmin, ws, {confirmName: "Acme"}), "workspace_deleted", 410)
    expect(await revisionOf(ws)).toBe(r)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, status: "active"})).toBe(0)
  })
})

describe("renameWorkspace", () => {
  test("admins and owners rename; names are validated; revision is checked and bumped", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    await addMember(ws, "mu_admin", "admin")
    await addMember(ws, "mu_dev", "developer")

    const renamed = await renameWorkspace(user("mu_admin"), ws, "  Acme Two ", 0)
    expect(renamed).toMatchObject({name: "Acme Two", authorizationRevision: 1})
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "workspace.renamed",
      before: {name: "Acme"},
      after: {name: "Acme Two"},
    })

    await expectError(() => renameWorkspace(user("mu_dev"), ws, "Nope", 1), "forbidden", 403)
    await expectError(() => renameWorkspace(user("mu_stranger"), ws, "Nope", 1), "forbidden", 403)
    await expectError(() => renameWorkspace(service, ws, "Nope", 1), "forbidden", 403)
    await expectError(() => renameWorkspace(user("mu_owner"), ws, "Nope", 0), "membership_changed", 409)
    await expectError(() => renameWorkspace(user("mu_owner"), ws, "   ", 1), "invalid_request", 400)
    await expectError(() => renameWorkspace(user("mu_owner"), ws, "x".repeat(81), 1), "invalid_request", 400)
    await expectError(() => renameWorkspace(user("mu_owner"), "ws_missing", "Nope", 1), "not_found", 404)
    expect((await getWorkspace(ws))!.name).toBe("Acme Two")

    expect((await renameWorkspace(orgAdmin, ws, "Acme Three", 1)).name).toBe("Acme Three")
  })

  test("renaming to the current name changes nothing", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")

    const summary = await renameWorkspace(user("mu_owner"), ws, " Acme ", 0)

    expect(summary).toMatchObject({name: "Acme", authorizationRevision: 0})
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "workspace.renamed"})).toBe(0)
  })
})

describe("queries", () => {
  test("listWorkspacesForUser uses only active memberships of non-deleted workspaces", async () => {
    await newWorkspace(user("mu_owner"), "First")
    const second = await newWorkspace(user("mu_other"), "Second")
    const third = await newWorkspace(user("mu_other"), "Third")
    const gone = await newWorkspace(user("mu_other"), "Gone")
    await addMember(second, "mu_me", "developer")
    await addMember(third, "mu_me", "member", {status: "ended", endedReason: "removed", endedAt: new Date()})
    await addMember(gone, "mu_me", "admin")
    await deleteWorkspace(user("mu_other"), gone, {confirmName: "Gone"})

    const listed = await listWorkspacesForUser("mu_me")

    expect(listed.map(item => item.workspaceId)).toEqual([second])
    expect(listed[0]).toMatchObject({
      name: "Second",
      status: "active",
      authorizationRevision: 0,
      membership: {role: "developer"},
    })
    expect(listed[0]!.capabilities).toContain("miniapps.publish")
    expect(listed[0]!.capabilities).not.toContain("workspace.members.manage")
    expect(await listWorkspacesForUser("mu_nobody")).toEqual([])
    // A missing id never becomes a match-anything filter.
    expect(await listWorkspacesForUser("")).toEqual([])
    expect(await listWorkspacesForUser("   ")).toEqual([])
  })

  test("listWorkspacesForUser lists a person's workspaces oldest first with each one's role", async () => {
    const first = await newWorkspace(user("mu_me"), "Mine")
    const second = await newWorkspace(user("mu_other"), "Theirs")
    await addMember(second, "mu_me", "admin")

    const listed = await listWorkspacesForUser("mu_me")

    expect(listed.map(item => [item.workspaceId, item.membership.role])).toEqual([
      [first, "owner"],
      [second, "admin"],
    ])
  })

  test("getWorkspace and getActiveMembership return null for unknown or inactive things", async () => {
    const ws = await newWorkspace()
    expect(await getWorkspace("ws_missing")).toBeNull()
    expect(await getWorkspace(ws)).toEqual({workspaceId: ws, name: "Acme", status: "active", authorizationRevision: 0})
    expect(await getActiveMembership(ws, "mu_stranger")).toBeNull()
    expect(await getActiveMembership(ws, "")).toBeNull()
    expect(await getActiveMembership("ws_missing", "mu_owner")).toBeNull()
    await removeMember(user("mu_owner"), ws, await addMember(ws, "mu_gone", "member"), 0)
    expect(await getActiveMembership(ws, "mu_gone")).toBeNull()
  })

  test("listMembers returns active memberships, oldest first", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_member", "member")
    await addMember(ws, "mu_old", "member", {status: "ended", endedReason: "left", endedAt: new Date()})
    await addMember(ws, "mu_dev", "developer")

    const members = await listMembers(ws)

    expect(members).toHaveLength(3)
    expect(members.every(member => member.status === "active")).toBe(true)
    expect(members.map(member => member.mentraUserId)).toEqual(["mu_owner", "mu_member", "mu_dev"])
    expect(await listMembers("ws_missing")).toEqual([])
  })

  test("listAllWorkspaces pages newest first by workspaceId cursor and includes deleted ones", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await newWorkspace(user(`mu_o${i}`), `W${i}`))
    await deleteWorkspace(system, ids[1]!, {confirmName: "W1"})

    const page1 = await listAllWorkspaces({limit: 2})
    expect(page1.map(item => item.workspaceId)).toEqual([ids[4], ids[3]])
    const page2 = await listAllWorkspaces({limit: 2, before: page1[1]!.workspaceId})
    expect(page2.map(item => item.workspaceId)).toEqual([ids[2], ids[1]])
    expect(page2[1]!.status).toBe("deleted")
    const page3 = await listAllWorkspaces({limit: 2, before: page2[1]!.workspaceId})
    expect(page3.map(item => item.workspaceId)).toEqual([ids[0]])
    expect(await listAllWorkspaces({limit: 2, before: ids[0]})).toEqual([])
    await expectError(() => listAllWorkspaces({limit: 2, before: "ws_missing"}), "invalid_request", 400)
    // The page size is clamped: zero still returns one.
    expect(await listAllWorkspaces({limit: 0})).toHaveLength(1)
  })
})

describe("audit", () => {
  test("recordWorkspaceEvent issues strictly increasing ids even inside one millisecond", async () => {
    const ids = await withTransaction(async session => {
      const issued: string[] = []
      for (let i = 0; i < 50; i++) {
        issued.push(
          await recordWorkspaceEvent(session, {
            workspaceId: "ws_ids",
            action: "test.event",
            actor: {kind: "system"},
            target: {i},
            requestId: null,
          }),
        )
      }
      return issued
    })

    expect(ids).toHaveLength(50)
    expect(ids.every(id => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(50)
    const stored = await WorkspaceAuditEventModel.find({workspaceId: "ws_ids"}).sort({eventId: 1}).lean()
    expect(stored.map(row => row.eventId)).toEqual(ids)
    expect(stored.map(row => (row.target as {i: number}).i)).toEqual(Array.from({length: 50}, (_, i) => i))
    expect(stored[0]!.occurredAt).toBeInstanceOf(Date)
  })

  test("each event records the id of the request that caused it, unless the caller names one", async () => {
    const record = (requestId?: string | null) =>
      withTransaction(session =>
        recordWorkspaceEvent(session, {
          workspaceId: "ws_req",
          action: "test.request",
          actor: {kind: "system"},
          target: {},
          ...(requestId === undefined ? {} : {requestId}),
        }),
      )
    const outside = await record()
    const inside = await runWithRequestId("req_ctx", () => record())
    const explicit = await runWithRequestId("req_ctx", () => record("req_explicit"))
    const ws = await runWithRequestId("req_create", () => newWorkspace())
    await runWithRequestId("req_rename", () => renameWorkspace(user("mu_owner"), ws, "Acme Two", 0))

    const requestIdOf = async (eventId: string) => (await WorkspaceAuditEventModel.findOne({eventId}).lean())!.requestId
    expect(await requestIdOf(outside)).toBeNull()
    expect(await requestIdOf(inside)).toBe("req_ctx")
    expect(await requestIdOf(explicit)).toBe("req_explicit")
    expect((await listWorkspaceAudit(ws, {limit: 10})).map(event => [event.action, event.requestId])).toEqual([
      ["workspace.renamed", "req_rename"],
      ["workspace.created", "req_create"],
    ])
  })

  test("a rolled-back mutation leaves no audit event behind", async () => {
    const ws = await newWorkspace()
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const events = await WorkspaceAuditEventModel.countDocuments({})

    await thrown(() => changeRole(user("mu_owner"), ws, ownerId, "admin", 0))
    await thrown(() =>
      withTransaction(async session => {
        await recordWorkspaceEvent(session, {
          workspaceId: ws,
          action: "test.rolled_back",
          actor: {kind: "system"},
          target: {},
        })
        throw new Error("abort")
      }),
    )

    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
  })

  test("redactSecrets removes credential-looking keys at any depth and keeps everything else", () => {
    const when = new Date("2026-03-01T00:00:00Z")
    const snapshot = {
      invitationId: "winv_1",
      tokenHash: "deadbeefdeadbeef",
      token: "tok-value",
      clientSecret: "s3cr3t-value",
      PASSWORD: "hunter2",
      nested: {secret: "s3cr3t-value", note: "kept", deeper: {refreshToken: "rt", hashAlgorithm: "sha256", at: when}},
      list: [{token: "tok-value", id: "keep"}, "plain", 3, null],
      revokedCredentialIds: ["01ABC"],
      role: "admin",
      count: 0,
      flag: false,
      missing: null,
    }

    expect(redactSecrets(snapshot)).toEqual({
      invitationId: "winv_1",
      nested: {note: "kept", deeper: {at: when}},
      list: [{id: "keep"}, "plain", 3, null],
      revokedCredentialIds: ["01ABC"],
      role: "admin",
      count: 0,
      flag: false,
      missing: null,
    })
    // Dates survive as Dates, and non-objects pass through.
    expect((redactSecrets({at: when}) as {at: unknown}).at).toBeInstanceOf(Date)
    for (const value of [null, undefined, "text", 7, true]) expect(redactSecrets(value)).toBe(value)
    expect(redactSecrets([{hash: "x"}, {name: "n"}])).toEqual([{}, {name: "n"}])
    // The input is not modified.
    expect(snapshot.tokenHash).toBe("deadbeefdeadbeef")
    expect(snapshot.nested.secret).toBe("s3cr3t-value")
  })

  test("an event carrying secret material comes out redacted through redactSecrets", async () => {
    const ws = await newWorkspace()
    await runWithRequestId("req_1", () =>
      withTransaction(session =>
        recordWorkspaceEvent(session, {
          workspaceId: ws,
          action: "invitation.created",
          actor: {kind: "user", mentraUserId: "mu_owner", email: "mu_owner@example.test"},
          target: {
            invitationId: "winv_1",
            tokenHash: "deadbeefdeadbeef",
            nested: {secret: "s3cr3t-value", note: "kept"},
            list: [{token: "tok-value", id: "keep"}],
          },
          before: {tokenHash: "deadbeefdeadbeef"},
          after: {secret: "s3cr3t-value", role: "member"},
        }),
      ),
    )

    const [event] = await listWorkspaceAudit(ws, {limit: 1})
    expect(event).toMatchObject({action: "invitation.created", requestId: "req_1"})
    const shown = {
      target: redactSecrets(event!.target),
      before: redactSecrets(event!.before),
      after: redactSecrets(event!.after),
    }
    expect(shown).toEqual({
      target: {invitationId: "winv_1", nested: {note: "kept"}, list: [{id: "keep"}]},
      before: {},
      after: {role: "member"},
    })
    const serialized = JSON.stringify(shown)
    for (const secret of ["deadbeef", "s3cr3t", "tok-value", "tokenHash"]) expect(serialized).not.toContain(secret)
  })

  test("the service's own events never carry a credential-looking key", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")
    await seedCredential(ws, memberId)
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)
    await renameWorkspace(user("mu_owner"), ws, "Acme Two", 1)
    await removeMember(user("mu_owner"), ws, memberId, 2)
    await accounts("mu_recovered")
    await recoverOwnership(orgAdmin, ws, "mu_recovered")
    const leaverId = await addMember(ws, "mu_leaver", "developer")
    await seedCredential(ws, leaverId)
    await leaveWorkspace(user("mu_leaver"), ws)
    await deleteWorkspace(orgAdmin, ws, {confirmName: "Acme Two"})

    const events = await WorkspaceAuditEventModel.find({workspaceId: ws}).sort({eventId: 1}).lean()
    expect(events.map(event => event.action)).toEqual([
      "workspace.created",
      "membership.role_changed",
      "workspace.renamed",
      "membership.removed",
      "membership.ownership_recovered",
      "membership.left",
      "workspace.deleted",
    ])
    for (const event of events) {
      for (const snapshot of [event.target, event.before, event.after]) {
        expect(redactSecrets(snapshot ?? null)).toEqual(snapshot ?? null)
      }
    }
  })

  test("listWorkspaceAudit returns one workspace's events newest first and pages by the before cursor", async () => {
    const ws = await newWorkspace()
    const other = await newWorkspace(user("mu_other"), "Other")
    const memberId = await addMember(ws, "mu_member", "member")
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)
    await renameWorkspace(user("mu_owner"), ws, "Acme Two", 1)
    // An organization-level event belongs to no workspace's page.
    await withTransaction(session =>
      recordWorkspaceEvent(session, {
        workspaceId: null,
        action: "credential.revoked",
        actor: {kind: "service", service: "store"},
        target: {credentialId: "01ABC"},
      }),
    )

    const page1 = await listWorkspaceAudit(ws, {limit: 2})
    expect(page1.map(event => event.action)).toEqual(["workspace.renamed", "membership.role_changed"])
    const page2 = await listWorkspaceAudit(ws, {limit: 2, before: page1[1]!.eventId})
    expect(page2.map(event => event.action)).toEqual(["workspace.created"])
    expect(await listWorkspaceAudit(ws, {limit: 2, before: page2[0]!.eventId})).toEqual([])
    expect(page1.every(event => event.workspaceId === ws)).toBe(true)
    expect(page1[0]).not.toHaveProperty("_id")
    expect(page1[0]).not.toHaveProperty("__v")
    expect((await listWorkspaceAudit(other, {limit: 10})).map(event => event.action)).toEqual(["workspace.created"])
    expect(await listWorkspaceAudit("ws_missing", {limit: 10})).toEqual([])
  })

  test("listWorkspaceAudit walks a long trail page by page, newest first, skipping and repeating nothing", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")
    const roles = ["developer", "member", "developer", "member", "developer", "member"] as const
    for (const [i, role] of roles.entries()) await changeRole(user("mu_owner"), ws, memberId, role, i)
    const all = await WorkspaceAuditEventModel.find({workspaceId: ws}).sort({eventId: -1}).lean()
    expect(all).toHaveLength(roles.length + 1)

    const collected: string[] = []
    let before: string | undefined
    let pages = 0
    for (;;) {
      const page = await listWorkspaceAudit(ws, {limit: 3, ...(before ? {before} : {})})
      if (page.length === 0) break
      pages++
      expect(page.length).toBeLessThanOrEqual(3)
      collected.push(...page.map(event => event.eventId))
      before = page.at(-1)!.eventId
    }

    expect(pages).toBe(3) // 3 + 3 + 1
    expect(collected).toEqual(all.map(event => event.eventId))
    expect([...collected].sort().reverse()).toEqual(collected)
    expect(new Set(collected).size).toBe(collected.length)
    // The page size is clamped to at least one.
    expect(await listWorkspaceAudit(ws, {limit: 0})).toHaveLength(1)
    expect(await listWorkspaceAudit(ws, {limit: -4})).toHaveLength(1)
  })

  test("clampPageSize keeps page sizes between 1 and 500", () => {
    expect(clampPageSize(1)).toBe(1)
    expect(clampPageSize(50)).toBe(50)
    expect(clampPageSize(2.9)).toBe(2)
    expect(clampPageSize(500)).toBe(500)
    expect(clampPageSize(501)).toBe(500)
    expect(clampPageSize(1e9)).toBe(500)
    const notNumbers = ["abc", undefined] as unknown as number[]
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, ...notNumbers]) expect(clampPageSize(bad)).toBe(1)
  })
})
