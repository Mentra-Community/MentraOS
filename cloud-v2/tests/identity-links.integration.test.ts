/**
 * @fileoverview WorkOS identity linking integration tests.
 *
 * `resolveWorkosUser` maps a WorkOS user to one stable `mentraUserId`. These
 * tests run the real service, models and transactions against a local replica
 * set; only GoTrue (the Mentra account directory) is faked, with a local
 * `Bun.serve` that speaks the admin users endpoint.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Prereq: a local replica set at `CLOUD_V2_TEST_MONGO_URL`
 * (default `mongodb://127.0.0.1:27017`, i.e. `docker-compose.test.yml`).
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/identity-links.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {resolveWorkosUser, type WorkosIdentity} from "../packages/core/src/services/workspaces/identity-link.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [IdentityLinkModel, UserModel, WorkspaceAuditEventModel, WorkspaceMembershipModel]

interface DirectoryUser {
  id: string
  email: string
  confirmed: boolean
}

let directoryUsers: DirectoryUser[] = []
let directoryRequests = 0
let directoryStatus = 200
// Like older GoTrue deployments, this directory ignores `filter`; the service
// under test must exact-match the email itself (findUserByEmail does).
const directory = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    directoryRequests++
    const url = new URL(req.url)
    if (url.pathname !== "/auth/v1/admin/users") return new Response(null, {status: 404})
    if (directoryStatus !== 200) return new Response(null, {status: directoryStatus})
    const page = Number(url.searchParams.get("page"))
    const perPage = Number(url.searchParams.get("per_page"))
    const users = directoryUsers.slice((page - 1) * perPage, page * perPage).map(user => ({
      id: user.id,
      email: user.email,
      email_confirmed_at: user.confirmed ? "2026-01-01T00:00:00Z" : null,
    }))
    return Response.json({users})
  },
})

const savedEnv = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false

function identity(overrides: Partial<WorkosIdentity> = {}): WorkosIdentity {
  return {
    workosUserId: "user_workos_1",
    email: "dev@example.test",
    emailVerified: true,
    name: "Dev One",
    ...overrides,
  }
}

async function seedMembership(fields: Record<string, unknown>) {
  return WorkspaceMembershipModel.create({
    membershipId: `wm_${Math.random().toString(36).slice(2)}`,
    organizationId: "local",
    workspaceId: "ws_1",
    mentraUserId: null,
    pendingWorkosUserId: null,
    email: "dev@example.test",
    name: "Dev One",
    role: "developer",
    status: "active",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    ...fields,
  })
}

beforeAll(async () => {
  process.env.SUPABASE_URL = directory.url.origin
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-directory-test-key"
  databaseUrl = localTestMongoUrl("identity-links")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, IdentityLinkModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))
})

afterAll(async () => {
  directory.stop(true)
  if (savedEnv.url === undefined) delete process.env.SUPABASE_URL
  else process.env.SUPABASE_URL = savedEnv.url
  if (savedEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key
  if (verified && IdentityLinkModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, IdentityLinkModel.db.name)
    await IdentityLinkModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, IdentityLinkModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  directoryUsers = []
  directoryRequests = 0
  directoryStatus = 200
})

afterEach(() => {
  directoryRequests = 0
})

describe("resolveWorkosUser: choosing the Mentra user", () => {
  test("(a) a verified email with a Mentra account links to the mentra tenant user", async () => {
    directoryUsers = [{id: "gotrue-alice", email: "Alice@Example.test", confirmed: true}]

    const {mentraUserId} = await resolveWorkosUser(identity({email: "alice@example.test"}))

    const user = await UserModel.findOne({tenantId: "mentra", tenantUserId: "gotrue-alice"}).lean()
    expect(user?.mentraUserId).toBe(mentraUserId)
    expect(await UserModel.countDocuments({tenantId: "workos"})).toBe(0)
    const link = await IdentityLinkModel.findOne({provider: "workos", subject: "user_workos_1"}).lean()
    expect(link).toMatchObject({mentraUserId, linkedVia: "verified_email", email: "alice@example.test"})
  })

  test("(a) reuses the Mentra user that already exists in Core instead of minting another", async () => {
    directoryUsers = [{id: "gotrue-bob", email: "bob@example.test", confirmed: true}]
    const existing = await UserModel.create({
      mentraUserId: "mu_existing_bob",
      tenantId: "mentra",
      tenantUserId: "gotrue-bob",
    })

    const {mentraUserId} = await resolveWorkosUser(identity({email: "bob@example.test"}))

    expect(mentraUserId).toBe(existing.mentraUserId)
    expect(await UserModel.countDocuments({})).toBe(1)
  })

  test("a Mentra account whose email is not confirmed does not capture the WorkOS user", async () => {
    directoryUsers = [{id: "gotrue-carol", email: "carol@example.test", confirmed: false}]

    const {mentraUserId} = await resolveWorkosUser(identity({email: "carol@example.test"}))

    const user = await UserModel.findOne({tenantId: "workos", tenantUserId: "user_workos_1"}).lean()
    expect(user?.mentraUserId).toBe(mentraUserId)
    expect(await UserModel.countDocuments({tenantId: "mentra"})).toBe(0)
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.linkedVia).toBe("workos_tenant")
  })

  test("a verified email with no Mentra account links to the workos tenant user", async () => {
    const {mentraUserId} = await resolveWorkosUser(identity({email: "nobody@example.test"}))

    const user = await UserModel.findOne({tenantId: "workos", tenantUserId: "user_workos_1"}).lean()
    expect(user?.mentraUserId).toBe(mentraUserId)
    expect(mentraUserId).toMatch(/^mu_/)
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.linkedVia).toBe("workos_tenant")
  })

  test("an unavailable GoTrue fails the first sign-in instead of linking to the workos tenant for good", async () => {
    directoryUsers = [{id: "gotrue-gina", email: "gina@example.test", confirmed: true}]
    directoryStatus = 503

    await expect(resolveWorkosUser(identity({email: "gina@example.test"}))).rejects.toThrow(/directory lookup failed/)
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    expect(await UserModel.countDocuments({})).toBe(0)

    // Once GoTrue answers again, the person links to their Mentra account.
    directoryStatus = 200
    const {mentraUserId} = await resolveWorkosUser(identity({email: "gina@example.test"}))
    expect((await UserModel.findOne({tenantId: "mentra", tenantUserId: "gotrue-gina"}).lean())?.mentraUserId).toBe(
      mentraUserId,
    )
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.linkedVia).toBe("verified_email")
  })

  test("(b) signing in again keeps the same id even after GoTrue gains an account for the email", async () => {
    const first = await resolveWorkosUser(identity({email: "late@example.test"}))
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.linkedVia).toBe("workos_tenant")

    // The same person later creates a Mentra account with the same email.
    directoryUsers = [{id: "gotrue-late", email: "late@example.test", confirmed: true}]
    directoryRequests = 0

    const second = await resolveWorkosUser(identity({email: "late@example.test"}))

    expect(second.mentraUserId).toBe(first.mentraUserId)
    // The existing link short-circuits: GoTrue is not even consulted.
    expect(directoryRequests).toBe(0)
    expect(await IdentityLinkModel.countDocuments({})).toBe(1)
    expect(await UserModel.countDocuments({tenantId: "mentra"})).toBe(0)

    // Only a WorkOS user that has never linked picks up the new Mentra account.
    const other = await resolveWorkosUser(identity({workosUserId: "user_workos_2", email: "late@example.test"}))
    expect(other.mentraUserId).not.toBe(first.mentraUserId)
    expect((await UserModel.findOne({tenantId: "mentra", tenantUserId: "gotrue-late"}).lean())?.mentraUserId).toBe(
      other.mentraUserId,
    )
  })

  test("(c) an unverified email always uses the workos tenant and never asks GoTrue", async () => {
    directoryUsers = [{id: "gotrue-dave", email: "dave@example.test", confirmed: true}]

    const {mentraUserId} = await resolveWorkosUser(identity({email: "dave@example.test", emailVerified: false}))

    expect(directoryRequests).toBe(0)
    const user = await UserModel.findOne({tenantId: "workos", tenantUserId: "user_workos_1"}).lean()
    expect(user?.mentraUserId).toBe(mentraUserId)
    expect(await UserModel.countDocuments({tenantId: "mentra"})).toBe(0)
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.linkedVia).toBe("workos_tenant")
  })

  test("a WorkOS user without an email uses the workos tenant and never asks GoTrue", async () => {
    const {mentraUserId} = await resolveWorkosUser(identity({email: null, emailVerified: true}))

    expect(directoryRequests).toBe(0)
    expect((await UserModel.findOne({tenantId: "workos", tenantUserId: "user_workos_1"}).lean())?.mentraUserId).toBe(
      mentraUserId,
    )
    expect(await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean()).toMatchObject({email: null})
  })

  test("rejects a blank WorkOS user id instead of linking everyone without one together", async () => {
    await expect(resolveWorkosUser(identity({workosUserId: ""}))).rejects.toThrow(/workosUserId/)
    await expect(resolveWorkosUser(identity({workosUserId: "   "}))).rejects.toThrow(/workosUserId/)
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
  })
})

describe("resolveWorkosUser: existing links", () => {
  test("returns the linked user and refreshes the display email only", async () => {
    const first = await resolveWorkosUser(identity({email: "old@example.test"}))

    const again = await resolveWorkosUser(identity({email: "new@example.test"}))
    expect(again.mentraUserId).toBe(first.mentraUserId)
    expect(await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean()).toMatchObject({
      mentraUserId: first.mentraUserId,
      email: "new@example.test",
      linkedVia: "workos_tenant",
    })

    // A sign-in that carries no email never erases the stored display email.
    await resolveWorkosUser(identity({email: null}))
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.email).toBe("new@example.test")
    expect(await IdentityLinkModel.countDocuments({})).toBe(1)
  })
})

describe("resolveWorkosUser: concurrent first logins", () => {
  test("(d) concurrent first logins produce one link row and one user", async () => {
    const results = await Promise.all(Array.from({length: 8}, () => resolveWorkosUser(identity())))

    expect(new Set(results.map(result => result.mentraUserId)).size).toBe(1)
    expect(await IdentityLinkModel.countDocuments({provider: "workos", subject: "user_workos_1"})).toBe(1)
    expect(await UserModel.countDocuments({tenantId: "workos"})).toBe(1)
    expect((await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean())?.mentraUserId).toBe(
      results[0]!.mentraUserId,
    )
  })

  test("(d) concurrent first logins through a verified email also produce one link row", async () => {
    directoryUsers = [{id: "gotrue-erin", email: "erin@example.test", confirmed: true}]

    const results = await Promise.all(
      Array.from({length: 6}, () => resolveWorkosUser(identity({email: "erin@example.test"}))),
    )

    expect(new Set(results.map(result => result.mentraUserId)).size).toBe(1)
    expect(await IdentityLinkModel.countDocuments({subject: "user_workos_1"})).toBe(1)
    expect(await UserModel.countDocuments({})).toBe(1)
  })

  test("a duplicate-key loss re-reads and returns the winner, claiming nothing itself", async () => {
    const winner = await UserModel.create({mentraUserId: "mu_winner", tenantId: "workos", tenantUserId: "someone-else"})
    await IdentityLinkModel.create({
      provider: "workos",
      subject: "user_workos_1",
      mentraUserId: winner.mentraUserId,
      email: "dev@example.test",
      linkedVia: "workos_tenant",
    })
    const pending = await seedMembership({pendingWorkosUserId: "user_workos_1"})
    // Simulate the race: the loser's first read happened before the winner committed.
    const findOne = spyOn(IdentityLinkModel, "findOne").mockImplementationOnce((() => ({
      lean: async () => null,
    })) as any)
    try {
      const result = await resolveWorkosUser(identity())
      expect(result.mentraUserId).toBe("mu_winner")
    } finally {
      findOne.mockRestore()
    }

    expect(await IdentityLinkModel.countDocuments({subject: "user_workos_1"})).toBe(1)
    // The loser's transaction rolled back, so its claim did not run.
    const row = await WorkspaceMembershipModel.findOne({membershipId: pending.membershipId}).lean()
    expect(row).toMatchObject({mentraUserId: null, pendingWorkosUserId: "user_workos_1", status: "active"})
  })
})

describe("resolveWorkosUser: claiming pending migrated memberships", () => {
  test("(e) claims pending memberships on first login and leaves everything else alone", async () => {
    const w1 = await seedMembership({workspaceId: "ws_1", pendingWorkosUserId: "user_workos_1", role: "owner"})
    const w2 = await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "member"})
    const someoneElse = await seedMembership({workspaceId: "ws_1", pendingWorkosUserId: "user_workos_other"})
    const ended = await seedMembership({
      workspaceId: "ws_3",
      pendingWorkosUserId: "user_workos_1",
      status: "ended",
      endedAt: new Date("2026-02-01T00:00:00Z"),
      endedReason: "removed",
    })

    const {mentraUserId} = await resolveWorkosUser(identity())

    expect(await WorkspaceMembershipModel.findOne({membershipId: w1.membershipId}).lean()).toMatchObject({
      mentraUserId,
      pendingWorkosUserId: null,
      status: "active",
      role: "owner",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: w2.membershipId}).lean()).toMatchObject({
      mentraUserId,
      pendingWorkosUserId: null,
      status: "active",
      role: "member",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: someoneElse.membershipId}).lean()).toMatchObject({
      mentraUserId: null,
      pendingWorkosUserId: "user_workos_other",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: ended.membershipId}).lean()).toMatchObject({
      mentraUserId: null,
      pendingWorkosUserId: "user_workos_1",
      status: "ended",
    })
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(0)
  })

  test("a duplicate of an active membership the user already holds is ended and audited", async () => {
    directoryUsers = [{id: "gotrue-frank", email: "frank@example.test", confirmed: true}]
    const frank = await UserModel.create({mentraUserId: "mu_frank", tenantId: "mentra", tenantUserId: "gotrue-frank"})
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: frank.mentraUserId, role: "admin"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "owner",
      organizationId: "acme",
    })
    const fresh = await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "member"})

    const {mentraUserId} = await resolveWorkosUser(identity({email: "frank@example.test"}))
    expect(mentraUserId).toBe("mu_frank")

    // The membership Frank already had is untouched.
    expect(await WorkspaceMembershipModel.findOne({membershipId: held.membershipId}).lean()).toMatchObject({
      mentraUserId: "mu_frank",
      status: "active",
      role: "admin",
    })
    // The pending duplicate is ended, not promoted.
    const ended = await WorkspaceMembershipModel.findOne({membershipId: duplicate.membershipId}).lean()
    expect(ended).toMatchObject({status: "ended", endedReason: "removed", mentraUserId: null})
    expect(ended?.endedAt).toBeInstanceOf(Date)
    // The non-duplicate is claimed.
    expect(await WorkspaceMembershipModel.findOne({membershipId: fresh.membershipId}).lean()).toMatchObject({
      mentraUserId: "mu_frank",
      pendingWorkosUserId: null,
      status: "active",
    })
    // Exactly one active Frank membership remains in ws_1.
    expect(
      await WorkspaceMembershipModel.countDocuments({workspaceId: "ws_1", mentraUserId: "mu_frank", status: "active"}),
    ).toBe(1)

    const events = await WorkspaceAuditEventModel.find({}).lean()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      organizationId: "acme",
      workspaceId: "ws_1",
      action: "membership.merged_duplicate",
      actor: {kind: "system"},
      target: {membershipId: duplicate.membershipId, mentraUserId: "mu_frank"},
      after: {status: "ended", endedReason: "removed", keptMembershipId: held.membershipId},
    })
    expect(events[0]!.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(events[0]!.occurredAt).toBeInstanceOf(Date)
  })

  test("the link and the claim commit together: a failed claim leaves no link behind", async () => {
    const pending = await seedMembership({pendingWorkosUserId: "user_workos_1"})
    const updateMany = spyOn(WorkspaceMembershipModel, "updateMany").mockRejectedValueOnce(new Error("claim failed"))
    try {
      await expect(resolveWorkosUser(identity())).rejects.toThrow("claim failed")
    } finally {
      updateMany.mockRestore()
    }

    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    expect(await WorkspaceMembershipModel.findOne({membershipId: pending.membershipId}).lean()).toMatchObject({
      mentraUserId: null,
      pendingWorkosUserId: "user_workos_1",
    })

    // A retry succeeds and claims.
    const {mentraUserId} = await resolveWorkosUser(identity())
    expect(await WorkspaceMembershipModel.findOne({membershipId: pending.membershipId}).lean()).toMatchObject({
      mentraUserId,
      pendingWorkosUserId: null,
    })
  })
})
