/**
 * @fileoverview Workspace lifecycle, membership and role-transition integration tests.
 *
 * These run the real services, models and transactions against a local replica
 * set; nothing is mocked except the Store package count, which is a callback.
 * The interesting cases are the concurrent ones: two owners demoting each other
 * (or leaving) at the same time must leave exactly one owner.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/workspace-service.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"

import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {
  listChanges,
  listWorkspaceAudit,
  recordWorkspaceEvent,
} from "../packages/core/src/services/workspaces/audit.service"
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

const MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
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
  await WorkspaceMembershipModel.create({
    membershipId,
    organizationId: "local",
    workspaceId,
    mentraUserId,
    email: `${mentraUserId}@example.test`,
    role,
    status: "active",
    startedAt: new Date(),
    ...fields,
  })
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

async function seedCredential(workspaceId: string, createdByMembershipId: string | null) {
  const credentialId = `01CRED${nextId()}`.toUpperCase()
  await AccessCredentialModel.create({
    credentialId,
    prefix: "msk",
    credentialKind: "workspace",
    organizationId: "local",
    workspaceId,
    name: "key",
    env: "local",
    hash: "a".repeat(64),
    last4: "abcd",
    createdByMembershipId,
  })
  return credentialId
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
  await Promise.all(MODELS.map(model => model.init()))
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
      organizationId: "local",
      workspaceId: expect.stringMatching(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/),
      name: "Acme Labs",
      status: "active",
      authorizationRevision: 0,
    })

    const membership = await getActiveMembership(summary.workspaceId, "mu_creator")
    expect(membership).toMatchObject({
      role: "owner",
      status: "active",
      email: "mu_creator@example.test",
      organizationId: "local",
    })
    expect(membership!.membershipId).toMatch(/^wm_[0-9A-HJKMNP-TV-Z]{26}$/)

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
      organizationId: "local",
      actor: {kind: "user", mentraUserId: "mu_creator", email: "mu_creator@example.test"},
      target: {workspaceId: summary.workspaceId, membershipId: membership!.membershipId},
    })
  })

  test("names are trimmed and must be 1-80 characters (400 invalid_request)", async () => {
    for (const bad of ["", "   ", "x".repeat(81), 42 as unknown as string]) {
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

  test("CLOUD_CORE_WORKSPACE_CREATION=organization-admins limits creation to organization admins", async () => {
    const saved = process.env.CLOUD_CORE_WORKSPACE_CREATION
    try {
      process.env.CLOUD_CORE_WORKSPACE_CREATION = "organization-admins"
      await expectError(() => createWorkspace(user("mu_plain"), {name: "Nope"}), "forbidden", 403)
      expect(await WorkspaceModel.countDocuments({})).toBe(0)
      expect((await createWorkspace(orgAdmin, {name: "Allowed"})).name).toBe("Allowed")

      process.env.CLOUD_CORE_WORKSPACE_CREATION = "open"
      expect((await createWorkspace(user("mu_plain"), {name: "Open"})).name).toBe("Open")

      // A typo must not silently open creation up.
      process.env.CLOUD_CORE_WORKSPACE_CREATION = "organization-admin"
      expect((await thrown(() => createWorkspace(user("mu_plain"), {name: "Typo"}))).message).toContain(
        "CLOUD_CORE_WORKSPACE_CREATION",
      )
    } finally {
      if (saved === undefined) delete process.env.CLOUD_CORE_WORKSPACE_CREATION
      else process.env.CLOUD_CORE_WORKSPACE_CREATION = saved
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
  })

  test("a role change is audited with before and after and bumps the revision once", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)

    const events = await listWorkspaceAudit(ws, {limit: 10})
    expect(events[0]).toMatchObject({
      action: "membership.role_changed",
      actor: {kind: "user", mentraUserId: "mu_owner"},
      target: {membershipId: memberId, mentraUserId: "mu_member"},
      before: {role: "member"},
      after: {role: "developer"},
    })
    expect(await revisionOf(ws)).toBe(1)
  })

  test("owner cannot demote themselves when they are the last owner (409 last_owner)", async () => {
    const ws = await newWorkspace()
    const ownerId = await membershipIdOf(ws, "mu_owner")

    await expectError(() => changeRole(user("mu_owner"), ws, ownerId, "admin", 0), "last_owner", 409)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("owner")
    expect(await revisionOf(ws)).toBe(0)

    // With a second owner, the same demotion goes through.
    await addMember(ws, "mu_owner2", "owner")
    await changeRole(user("mu_owner"), ws, ownerId, "admin", 0)
    expect((await getActiveMembership(ws, "mu_owner"))!.role).toBe("admin")
    expect(await countActiveOwners(ws)).toBe(1)
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
      expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws, action: "membership.role_changed"})).toBe(
        1,
      )
    }
  })

  test("stale expectedRevision returns 409 membership_changed", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)

    await expectError(() => changeRole(user("mu_owner"), ws, memberId, "member", 0), "membership_changed", 409)
    await expectError(() => changeRole(user("mu_owner"), ws, memberId, "member", 7), "membership_changed", 409)
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")
    expect(await revisionOf(ws)).toBe(1)
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

    for (const id of memberKeys) {
      expect((await AccessCredentialModel.findOne({credentialId: id}).lean())!.revokedAt).toBeInstanceOf(Date)
    }
    expect((await AccessCredentialModel.findOne({credentialId: ownerKey}).lean())!.revokedAt).toBeNull()
    expect((await AccessCredentialModel.findOne({credentialId: unrelatedKey}).lean())!.revokedAt).toBeNull()
    // A credential that was already revoked keeps its original revocation time.
    expect((await AccessCredentialModel.findOne({credentialId: alreadyRevoked}).lean())!.revokedAt).toEqual(earlier)
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
      target: {membershipId: memberId, mentraUserId: "mu_member"},
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
    // An admin may remove a developer but not another admin.
    await expectError(() => removeMember(user("mu_admin2"), ws, adminId, 0), "forbidden", 403)
    await removeMember(user("mu_admin2"), ws, developerId, 0)
    expect(await getActiveMembership(ws, "mu_dev")).toBeNull()
    // Services cannot mutate memberships.
    await expectError(() => removeMember(service, ws, adminId, 1), "forbidden", 403)
    await removeMember(user("mu_owner"), ws, adminId, 1)
    expect(await getActiveMembership(ws, "mu_admin")).toBeNull()
    expect(await revisionOf(ws)).toBe(2)
  })

  test("a stale revision or an already-ended membership does not remove anything", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await expectError(() => removeMember(user("mu_owner"), ws, memberId, 3), "membership_changed", 409)
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
    expect((await AccessCredentialModel.findOne({credentialId: key}).lean())!.revokedAt).toBeInstanceOf(Date)
    expect(await revisionOf(ws)).toBe(1)
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.left",
      actor: {kind: "user", mentraUserId: "mu_member"},
      target: {membershipId: memberId, mentraUserId: "mu_member"},
    })
    expect(await listWorkspacesForUser("mu_member")).toEqual([])
  })

  test("the last owner cannot leave; a non-member has nothing to leave", async () => {
    const ws = await newWorkspace()

    await expectError(() => leaveWorkspace(user("mu_owner"), ws), "last_owner", 409)
    await expectError(() => leaveWorkspace(user("mu_stranger"), ws), "not_found", 404)
    await expectError(() => leaveWorkspace(user("mu_owner"), "ws_missing"), "not_found", 404)
    expect(await countActiveOwners(ws)).toBe(1)

    await addMember(ws, "mu_owner2", "owner")
    await leaveWorkspace(user("mu_owner"), ws)
    expect(await countActiveOwners(ws)).toBe(1)
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
      expect(rejected.reason.code).toBe("last_owner")
      expect(await countActiveOwners(ws)).toBe(1)
    }
  })
})

describe("recoverOwnership", () => {
  test("organization admin recovers ownership of a workspace whose owners all left", async () => {
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
    expect(membership).toMatchObject({role: "owner", status: "active", organizationId: "local"})
    expect(membership!.membershipId).toMatch(/^wm_/)
    expect((await listWorkspacesForUser("mu_new_owner"))[0]!.membership.role).toBe("owner")
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.ownership_recovered",
      actor: {kind: "user", mentraUserId: "mu_org_admin"},
      target: {membershipId: membership!.membershipId, mentraUserId: "mu_new_owner"},
      before: {role: null},
      after: {role: "owner"},
    })
  })

  test("an existing member is promoted to owner in place", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    await recoverOwnership(system, ws, "mu_member")

    expect(await getActiveMembership(ws, "mu_member")).toMatchObject({membershipId: memberId, role: "owner"})
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, mentraUserId: "mu_member"})).toBe(1)
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "membership.ownership_recovered",
      before: {role: "member"},
      after: {role: "owner"},
    })
  })

  test("someone who is already an owner is left alone", async () => {
    const ws = await newWorkspace()

    const summary = await recoverOwnership(orgAdmin, ws, "mu_owner")

    expect(summary.authorizationRevision).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.ownership_recovered"})).toBe(0)
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
  })
})

describe("deleteWorkspace", () => {
  test("delete refuses when ownedPackageCount > 0 and when confirmName mismatches", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    let calls = 0
    const count = (n: number) => async () => {
      calls++
      return n
    }

    await expectError(
      () => deleteWorkspace(user("mu_owner"), ws, {confirmName: "acme", ownedPackageCount: count(0)}),
      "invalid_request",
      400,
    )
    expect(calls).toBe(0)

    await expectError(
      () => deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme", ownedPackageCount: count(2)}),
      "workspace_has_packages",
      409,
    )
    expect(calls).toBe(1)
    expect((await getWorkspace(ws))!.status).toBe("active")
    expect(await getActiveMembership(ws, "mu_owner")).not.toBeNull()

    // The Store being unreachable is its own failure, and nothing is deleted.
    await expectError(
      () =>
        deleteWorkspace(user("mu_owner"), ws, {
          confirmName: "Acme",
          ownedPackageCount: async () => {
            throw new Error("store down")
          },
        }),
      "store_unavailable",
      503,
    )
    expect((await getWorkspace(ws))!.status).toBe("active")

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme", ownedPackageCount: count(0)})
    expect((await getWorkspace(ws))!.status).toBe("deleted")
  })

  test("only an owner or an organization admin may delete", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    await addMember(ws, "mu_admin", "admin")
    let calls = 0
    const opts = {
      confirmName: "Acme",
      ownedPackageCount: async () => {
        calls++
        return 0
      },
    }

    await expectError(() => deleteWorkspace(user("mu_admin"), ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(user("mu_stranger"), ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(service, ws, opts), "forbidden", 403)
    await expectError(() => deleteWorkspace(user("mu_owner"), "ws_missing", opts), "not_found", 404)
    expect(calls).toBe(0)
    expect((await getWorkspace(ws))!.status).toBe("active")

    await deleteWorkspace(orgAdmin, ws, opts)
    expect((await getWorkspace(ws))!.status).toBe("deleted")
  })

  test("deleting ends every membership, revokes every credential and pending invitation, and audits", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    const memberId = await addMember(ws, "mu_member", "member")
    const pendingId = await addMember(ws, "mu_pending", "developer", {
      mentraUserId: null,
      pendingWorkosUserId: "user_01",
    })
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const creds = [
      await seedCredential(ws, ownerId),
      await seedCredential(ws, memberId),
      await seedCredential(ws, null),
    ]
    const elsewhere = await newWorkspace(user("mu_x"), "Elsewhere")
    const unrelatedKey = await seedCredential(elsewhere, null)
    const invite = (invitationId: string, email: string, status: string) =>
      WorkspaceInvitationModel.create({
        invitationId,
        organizationId: "local",
        workspaceId: ws,
        email,
        role: "member",
        tokenHash: "b".repeat(64),
        status,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    await invite("winv_pending", "p@example.test", "pending")
    await invite("winv_accepted", "a@example.test", "accepted")
    const before = await revisionOf(ws)

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme", ownedPackageCount: async () => 0})

    const deleted = await WorkspaceModel.findOne({workspaceId: ws}).lean()
    expect(deleted).toMatchObject({status: "deleted", authorizationRevision: before + 1})
    expect(deleted!.deletedAt).toBeInstanceOf(Date)
    expect(await countActiveOwners(ws)).toBe(0)
    const rows = await WorkspaceMembershipModel.find({workspaceId: ws}).lean()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row).toMatchObject({status: "ended", endedReason: "workspace_deleted"})
      expect(row.endedAt).toBeInstanceOf(Date)
    }
    expect(rows.map(row => row.membershipId).sort()).toEqual([memberId, pendingId, ownerId].sort())
    for (const id of creds) {
      expect((await AccessCredentialModel.findOne({credentialId: id}).lean())!.revokedAt).toBeInstanceOf(Date)
    }
    expect((await AccessCredentialModel.findOne({credentialId: unrelatedKey}).lean())!.revokedAt).toBeNull()
    expect((await WorkspaceInvitationModel.findOne({invitationId: "winv_pending"}).lean())!.status).toBe("revoked")
    expect((await WorkspaceInvitationModel.findOne({invitationId: "winv_accepted"}).lean())!.status).toBe("accepted")
    expect((await getWorkspace(elsewhere))!.status).toBe("active")

    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "workspace.deleted",
      actor: {kind: "user", mentraUserId: "mu_owner"},
      target: {workspaceId: ws},
      before: {name: "Acme", status: "active"},
      after: {status: "deleted"},
    })
    expect(await listWorkspacesForUser("mu_owner")).toEqual([])
    expect(await listWorkspacesForUser("mu_member")).toEqual([])
  })

  test("a deleted workspace refuses every further change (410 workspace_deleted)", async () => {
    const ws = await newWorkspace(user("mu_owner"), "Acme")
    const memberId = await addMember(ws, "mu_member", "member")
    await deleteWorkspace(system, ws, {confirmName: "Acme", ownedPackageCount: async () => 0})
    const r = await revisionOf(ws)

    await expectError(() => changeRole(orgAdmin, ws, memberId, "admin", r), "workspace_deleted", 410)
    await expectError(() => removeMember(orgAdmin, ws, memberId, r), "workspace_deleted", 410)
    await expectError(() => renameWorkspace(orgAdmin, ws, "New", r), "workspace_deleted", 410)
    await expectError(() => recoverOwnership(orgAdmin, ws, "mu_x"), "workspace_deleted", 410)
    await expectError(() => leaveWorkspace(user("mu_member"), ws), "workspace_deleted", 410)
    await expectError(
      () => deleteWorkspace(orgAdmin, ws, {confirmName: "Acme", ownedPackageCount: async () => 0}),
      "workspace_deleted",
      410,
    )
    expect(await revisionOf(ws)).toBe(r)
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
    expect((await getWorkspace(ws))!.name).toBe("Acme Two")

    expect((await renameWorkspace(orgAdmin, ws, "Acme Three", 1)).name).toBe("Acme Three")
  })
})

describe("queries", () => {
  test("listWorkspacesForUser uses only claimed, active memberships of non-deleted workspaces", async () => {
    const first = await newWorkspace(user("mu_owner"), "First")
    const second = await newWorkspace(user("mu_other"), "Second")
    const third = await newWorkspace(user("mu_other"), "Third")
    const gone = await newWorkspace(user("mu_other"), "Gone")
    await addMember(second, "mu_me", "developer")
    await addMember(third, "mu_me", "member", {status: "ended", endedReason: "removed", endedAt: new Date()})
    await addMember(gone, "mu_me", "admin")
    await addMember(first, "mu_not_me", "owner", {mentraUserId: null, pendingWorkosUserId: "user_pending_me"})
    await deleteWorkspace(user("mu_other"), gone, {confirmName: "Gone", ownedPackageCount: async () => 0})

    const listed = await listWorkspacesForUser("mu_me")

    expect(listed.map(item => item.workspaceId)).toEqual([second])
    expect(listed[0]).toMatchObject({
      organizationId: "local",
      name: "Second",
      status: "active",
      authorizationRevision: 0,
      membership: {role: "developer"},
    })
    expect(listed[0]!.capabilities).toContain("miniapps.publish")
    expect(listed[0]!.capabilities).not.toContain("workspace.members.manage")
    // A migrated row that has not been claimed is not "mine" until sign-in claims it.
    expect(await listWorkspacesForUser("user_pending_me")).toEqual([])
    expect(await listWorkspacesForUser("mu_nobody")).toEqual([])
  })

  test("getWorkspace and getActiveMembership return null for unknown or inactive things", async () => {
    const ws = await newWorkspace()
    expect(await getWorkspace("ws_missing")).toBeNull()
    expect(await getWorkspace(ws)).toMatchObject({workspaceId: ws, name: "Acme", status: "active"})
    expect(await getActiveMembership(ws, "mu_stranger")).toBeNull()
    expect(await getActiveMembership("ws_missing", "mu_owner")).toBeNull()
    await removeMember(user("mu_owner"), ws, await addMember(ws, "mu_gone", "member"), 0)
    expect(await getActiveMembership(ws, "mu_gone")).toBeNull()
  })

  test("listMembers returns active memberships, unclaimed migrated ones included", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_member", "member")
    await addMember(ws, "mu_old", "member", {status: "ended", endedReason: "left", endedAt: new Date()})
    await addMember(ws, "mu_pending", "developer", {mentraUserId: null, pendingWorkosUserId: "user_p"})

    const members = await listMembers(ws)

    expect(members).toHaveLength(3)
    expect(members.every(member => member.status === "active")).toBe(true)
    expect(members.map(member => member.mentraUserId)).toEqual(["mu_owner", "mu_member", null])
    expect(await listMembers("ws_missing")).toEqual([])
  })

  test("listAllWorkspaces pages newest first by workspaceId cursor and includes deleted ones", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await newWorkspace(user(`mu_o${i}`), `W${i}`))
    await deleteWorkspace(system, ids[1]!, {confirmName: "W1", ownedPackageCount: async () => 0})

    const page1 = await listAllWorkspaces({limit: 2})
    expect(page1.map(item => item.workspaceId)).toEqual([ids[4], ids[3]])
    const page2 = await listAllWorkspaces({limit: 2, before: page1[1]!.workspaceId})
    expect(page2.map(item => item.workspaceId)).toEqual([ids[2], ids[1]])
    expect(page2[1]!.status).toBe("deleted")
    const page3 = await listAllWorkspaces({limit: 2, before: page2[1]!.workspaceId})
    expect(page3.map(item => item.workspaceId)).toEqual([ids[0]])
    expect(await listAllWorkspaces({limit: 2, before: ids[0]})).toEqual([])
    await expectError(() => listAllWorkspaces({limit: 2, before: "ws_missing"}), "invalid_request", 400)
  })
})

describe("audit", () => {
  test("recordWorkspaceEvent issues strictly increasing ids even inside one millisecond", async () => {
    const ids = await withTransaction(async session => {
      const issued: string[] = []
      for (let i = 0; i < 50; i++) {
        issued.push(
          await recordWorkspaceEvent(session, {
            organizationId: "local",
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
    expect(stored[0]!.occurredAt).toBeInstanceOf(Date)
    // Each event also took the next change-feed position, one by one with no gaps.
    expect(stored.map(row => row.seq)).toEqual(Array.from({length: 50}, (_, i) => i + 1))
  })

  test("a rolled-back mutation leaves no audit event behind", async () => {
    const ws = await newWorkspace()
    const ownerId = await membershipIdOf(ws, "mu_owner")
    const events = await WorkspaceAuditEventModel.countDocuments({})

    await thrown(() => changeRole(user("mu_owner"), ws, ownerId, "admin", 0))

    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
  })

  test("listChanges pages by seq and never includes secrets or token hashes", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)
    await renameWorkspace(user("mu_owner"), ws, "Acme Two", 1)
    await removeMember(user("mu_owner"), ws, memberId, 2)
    // An event whose snapshot carries secret material (as a careless writer might produce)
    // and one that belongs to the organization rather than a workspace.
    await withTransaction(async session => {
      await recordWorkspaceEvent(session, {
        organizationId: "local",
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
        after: {secret: "s3cr3t-value"},
        requestId: "req_1",
      })
      await recordWorkspaceEvent(session, {
        organizationId: "local",
        workspaceId: null,
        action: "credential.revoked",
        actor: {kind: "service", service: "store"},
        target: {credentialId: "01ABC"},
        requestId: null,
      })
    })
    const total = await WorkspaceAuditEventModel.countDocuments({})
    expect(total).toBe(6)

    const collected: Awaited<ReturnType<typeof listChanges>>["events"] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await listChanges(cursor, 2)
      pages++
      expect(page.events.length).toBeLessThanOrEqual(2)
      collected.push(...page.events)
      expect(page.next).toBe(page.events.length === 2 ? String(page.events[1]!.seq) : null)
      cursor = page.next
    } while (cursor)

    expect(pages).toBe(4) // 2 + 2 + 2 + the empty page after a full one
    expect(collected).toHaveLength(total)
    const eventIds = collected.map(event => event.eventId)
    expect([...eventIds].sort()).toEqual(eventIds)
    expect(new Set(eventIds).size).toBe(total)
    // seq is the feed position: 1..n in order, and what `next` hands back as the cursor.
    expect(collected.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(collected.map(event => event.action)).toEqual([
      "workspace.created",
      "membership.role_changed",
      "workspace.renamed",
      "membership.removed",
      "invitation.created",
      "credential.revoked",
    ])
    for (const event of collected) {
      expect(Object.keys(event).sort()).toEqual([
        "action",
        "eventId",
        "occurredAt",
        "organizationId",
        "seq",
        "target",
        "workspaceId",
      ])
      expect(event.organizationId).toBe("local")
      expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt)
    }
    expect(collected[0]!.workspaceId).toBe(ws)
    expect(collected[5]!.workspaceId).toBeNull()

    const serialized = JSON.stringify(collected)
    for (const secret of ["deadbeef", "s3cr3t", "tok-value", "tokenHash", "req_1", "mu_owner@example.test"]) {
      expect(serialized).not.toContain(secret)
    }
    expect(collected[4]!.target).toEqual({invitationId: "winv_1", nested: {note: "kept"}, list: [{id: "keep"}]})

    // The cursor is exclusive: resuming after a seq returns only later events.
    const resumed = await listChanges("3", 100)
    expect(resumed.events.map(event => event.eventId)).toEqual(eventIds.slice(3))
    expect(resumed.next).toBeNull()
    expect((await listChanges("6", 10)).events).toEqual([])
    expect((await listChanges("99", 10)).events).toEqual([])
    expect((await listChanges("0", 3)).events.map(event => event.eventId)).toEqual(eventIds.slice(0, 3))
    expect((await listChanges(null, 3)).events.map(event => event.eventId)).toEqual(eventIds.slice(0, 3))
  })

  test("listChanges rejects a cursor that is not a change sequence number (400 invalid_request)", async () => {
    await newWorkspace()
    for (const bad of [
      "",
      "abc",
      "-1",
      "1.5",
      "01",
      "1e3",
      " 2",
      "01JABCDEFGHJKMNPQRSTVWXYZ0",
      "99999999999999999999",
    ]) {
      await expectError(() => listChanges(bad, 10), "invalid_request", 400)
    }
  })

  test("seq is issued per organization and listChanges serves only this organization's events", async () => {
    const record = (organization: string, n: number) =>
      withTransaction(session =>
        recordWorkspaceEvent(session, {
          organizationId: organization,
          workspaceId: null,
          action: `test.${n}`,
          actor: {kind: "system"},
          target: {n},
        }),
      )
    await record("local", 1)
    await record("other-org", 2)
    await record("other-org", 3)
    await record("local", 4)

    const seqs = async (organization: string) =>
      (await WorkspaceAuditEventModel.find({organizationId: organization}).sort({seq: 1}).lean()).map(row => row.seq)
    expect(await seqs("local")).toEqual([1, 2])
    expect(await seqs("other-org")).toEqual([1, 2])
    const feed = await listChanges(null, 10)
    expect(feed.events.map(event => [event.action, event.seq])).toEqual([
      ["test.1", 1],
      ["test.4", 2],
    ])
  })

  test("the first event of an organization retries instead of failing when its counter appears mid-transaction", async () => {
    let attempts = 0
    await withTransaction(async session => {
      attempts++
      // Take this transaction's snapshot while the counter does not exist yet.
      await WorkspaceModel.findOne({workspaceId: "ws_none"}).session(session)
      // Another writer creates the counter and commits during the first attempt.
      if (attempts === 1) await WorkspaceAuditCounterModel.create({_id: "local", seq: 5})
      await recordWorkspaceEvent(session, {
        organizationId: "local",
        workspaceId: null,
        action: "test.first",
        actor: {kind: "system"},
        target: {},
      })
    })

    expect(attempts).toBe(2)
    expect((await WorkspaceAuditEventModel.find({}).lean()).map(row => row.seq)).toEqual([6])
    expect((await WorkspaceAuditCounterModel.findById("local").lean())!.seq).toBe(6)
  })

  test("interleaved transactions: a later-committing event never gets a lower seq, so a poller cannot skip it", async () => {
    const event = (n: number) => ({
      organizationId: "local",
      workspaceId: "ws_gate",
      action: `test.${n}`,
      actor: {kind: "system" as const},
      target: {n},
    })
    const gate = () => {
      let open!: () => void
      const opened = new Promise<void>(resolve => (open = resolve))
      return {open, opened}
    }
    const [gateA, gateB] = [gate(), gate()]
    let aHasSeq!: () => void
    const aRecorded = new Promise<void>(resolve => (aHasSeq = resolve))
    let bHasSeq!: () => void
    const bRecorded = new Promise<void>(resolve => (bHasSeq = resolve))
    let bAttempts = 0
    let bHoldsSeq = false

    // A takes the first seq and stays uncommitted.
    const txA = withTransaction(async session => {
      await recordWorkspaceEvent(session, event(1))
      aHasSeq()
      await gateA.opened
    })
    await aRecorded
    // B starts while A is open. Before the counter, B would mint a later id and could commit first.
    const txB = withTransaction(async session => {
      bAttempts++
      bHoldsSeq = false
      await recordWorkspaceEvent(session, event(2))
      bHoldsSeq = true
      bHasSeq()
      await gateB.opened
    })
    while (bAttempts < 1) await Bun.sleep(1)
    await Bun.sleep(100)

    // While A is open B cannot hold a seq (it keeps conflicting and retrying), and a poller sees neither event.
    expect(bAttempts).toBeGreaterThan(1)
    expect(bHoldsSeq).toBe(false)
    expect((await listChanges(null, 10)).events).toEqual([])

    // A commits. B now gets the next seq but is still uncommitted: a poller sees only A.
    gateA.open()
    await txA
    await bRecorded
    const first = await listChanges(null, 10)
    expect(first.events.map(e => [e.action, e.seq])).toEqual([["test.1", 1]])
    const cursor = String(first.events.at(-1)!.seq)

    // B commits. The poller resumes from its cursor and gets B: nothing was skipped.
    gateB.open()
    await txB
    const second = await listChanges(cursor, 10)
    expect(second.events.map(e => [e.action, e.seq])).toEqual([["test.2", 2]])
    expect((await listChanges(null, 10)).events.map(e => e.seq)).toEqual([1, 2])
  })

  test("concurrent recorders: a polling consumer sees every event exactly once, in seq order, with no gaps", async () => {
    const writers = 6
    const perWriter = 2
    let writing = true
    const seen: Array<{seq: number; eventId: string}> = []
    const poller = (async () => {
      let cursor: string | null = null
      for (;;) {
        const writersFinished = !writing
        const page = await listChanges(cursor, 3)
        seen.push(...page.events.map(e => ({seq: e.seq, eventId: e.eventId})))
        if (page.events.length > 0) cursor = String(page.events.at(-1)!.seq)
        else if (writersFinished) return
        else await Bun.sleep(2)
      }
    })()

    await Promise.all(
      Array.from({length: writers}, (_, writer) =>
        withTransaction(async session => {
          for (let i = 0; i < perWriter; i++) {
            await recordWorkspaceEvent(session, {
              organizationId: "local",
              workspaceId: `ws_${writer}`,
              action: "test.concurrent",
              actor: {kind: "system"},
              target: {writer, i},
            })
          }
          await Bun.sleep(Math.floor(Math.random() * 8))
        }),
      ),
    )
    writing = false
    await poller

    const total = writers * perWriter
    expect(seen.map(e => e.seq)).toEqual(Array.from({length: total}, (_, i) => i + 1))
    expect(new Set(seen.map(e => e.eventId)).size).toBe(total)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(total)
  })

  test("listWorkspaceAudit returns one workspace's events newest first and pages by the before cursor", async () => {
    const ws = await newWorkspace()
    const other = await newWorkspace(user("mu_other"), "Other")
    const memberId = await addMember(ws, "mu_member", "member")
    await changeRole(user("mu_owner"), ws, memberId, "developer", 0)
    await renameWorkspace(user("mu_owner"), ws, "Acme Two", 1)

    const page1 = await listWorkspaceAudit(ws, {limit: 2})
    expect(page1.map(event => event.action)).toEqual(["workspace.renamed", "membership.role_changed"])
    const page2 = await listWorkspaceAudit(ws, {limit: 2, before: page1[1]!.eventId})
    expect(page2.map(event => event.action)).toEqual(["workspace.created"])
    expect(page1.every(event => event.workspaceId === ws)).toBe(true)
    expect((await listWorkspaceAudit(other, {limit: 10})).map(event => event.action)).toEqual(["workspace.created"])
    expect(await listWorkspaceAudit("ws_missing", {limit: 10})).toEqual([])
  })
})
