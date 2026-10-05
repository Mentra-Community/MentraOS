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

import {createHash, randomBytes} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {validateCredentialToken} from "../packages/core/src/services/workspaces/credential.service"
import {resolveWorkosUser, type WorkosIdentity} from "../packages/core/src/services/workspaces/identity-link.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [
  AccessCredentialModel,
  IdentityLinkModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

interface DirectoryUser {
  id: string
  email: string
  confirmed: boolean
}

let directoryUsers: DirectoryUser[] = []
let directoryRequests = 0
let directoryStatus = 200
// "ok" answers from directoryUsers; the others model a directory that cannot give a definite answer.
let directoryMode: "ok" | "malformed" | "neverEnds" | "hang" = "ok"
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
    if (directoryMode === "hang") return new Promise<Response>(() => {})
    if (directoryMode === "malformed") return Response.json({users: "not a list"})
    const page = Number(url.searchParams.get("page"))
    const perPage = Number(url.searchParams.get("per_page"))
    if (directoryMode === "neverEnds") {
      // Every page is full of other people, forever.
      return Response.json({
        users: Array.from({length: perPage}, (_, i) => ({
          id: `other-${page}-${i}`,
          email: `other-${page}-${i}@example.test`,
          email_confirmed_at: "2026-01-01T00:00:00Z",
        })),
      })
    }
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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A credential id in ULID form (26 Crockford base32 characters). */
const ulid = () => Array.from(randomBytes(26), byte => CROCKFORD[byte % 32]).join("")

/** A migrated workspace key created by `membershipId`, returned with its bearer token. */
async function seedCredential(fields: {workspaceId: string; createdByMembershipId: string; revokedAt?: Date | null}) {
  const credentialId = ulid()
  const secret = "S".repeat(43)
  await AccessCredentialModel.create({
    credentialId,
    prefix: "msk",
    credentialKind: "workspace",
    organizationId: "local",
    name: "migrated key",
    env: "local",
    hash: createHash("sha256").update(secret).digest("hex"),
    last4: secret.slice(-4),
    scopes: ["miniapps.publish"],
    ...fields,
  })
  return {credentialId, token: `msk_local_${credentialId}.${secret}`}
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
  directoryMode = "ok"
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

  test("a directory answer that is not a user list fails the first sign-in", async () => {
    directoryMode = "malformed"

    await expect(resolveWorkosUser(identity({email: "hana@example.test"}))).rejects.toThrow(/directory lookup failed/)
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("a directory too large to scan fails the first sign-in instead of reading as no account", async () => {
    directoryMode = "neverEnds"

    await expect(resolveWorkosUser(identity({email: "ivan@example.test"}))).rejects.toThrow(/directory lookup failed/)
    expect(directoryRequests).toBe(20)
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("a hung directory fails the first sign-in at the timeout instead of hanging", async () => {
    directoryMode = "hang"
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(100))
    try {
      await expect(resolveWorkosUser(identity({email: "jo@example.test"}))).rejects.toThrow(/timed out/)
    } finally {
      timeout.mockRestore()
    }
    expect(await IdentityLinkModel.countDocuments({})).toBe(0)
    expect(await UserModel.countDocuments({})).toBe(0)
  })

  test("without GoTrue admin credentials the lookup is skipped and the user links to the workos tenant", async () => {
    directoryUsers = [{id: "gotrue-kim", email: "kim@example.test", confirmed: true}]
    const configured = {url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY}
    try {
      const cases: Array<[string, () => void]> = [
        ["no URL", () => delete process.env.SUPABASE_URL],
        ["no service-role key", () => delete process.env.SUPABASE_SERVICE_ROLE_KEY],
        ["blank key", () => (process.env.SUPABASE_SERVICE_ROLE_KEY = "   ")],
        ["neither", () => (delete process.env.SUPABASE_URL, delete process.env.SUPABASE_SERVICE_ROLE_KEY)],
      ]
      for (const [index, [label, unconfigure]] of cases.entries()) {
        process.env.SUPABASE_URL = configured.url
        process.env.SUPABASE_SERVICE_ROLE_KEY = configured.key
        unconfigure()
        const subject = `user_workos_unconfigured_${index}`

        const {mentraUserId} = await resolveWorkosUser(identity({workosUserId: subject, email: "kim@example.test"}))

        expect({label, requests: directoryRequests}).toEqual({label, requests: 0})
        expect((await UserModel.findOne({tenantId: "workos", tenantUserId: subject}).lean())?.mentraUserId).toBe(
          mentraUserId,
        )
        expect((await IdentityLinkModel.findOne({subject}).lean())?.linkedVia).toBe("workos_tenant")
      }
      expect(await UserModel.countDocuments({tenantId: "mentra"})).toBe(0)
    } finally {
      process.env.SUPABASE_URL = configured.url
      process.env.SUPABASE_SERVICE_ROLE_KEY = configured.key
    }
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

  test("a duplicate-key loss re-reads, returns the winner, and still claims for the winner's user", async () => {
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
    // The loser's own link transaction rolled back, and it never links to the user it computed.
    expect(await IdentityLinkModel.findOne({subject: "user_workos_1"}).lean()).toMatchObject({
      mentraUserId: "mu_winner",
    })
    // The pending row still ends up with the linked (winner's) user.
    expect(await WorkspaceMembershipModel.findOne({membershipId: pending.membershipId}).lean()).toMatchObject({
      mentraUserId: "mu_winner",
      pendingWorkosUserId: null,
      status: "active",
    })
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
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One"})
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: frank.mentraUserId, role: "admin"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "developer",
      organizationId: "acme",
    })
    const fresh = await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "member"})

    const {mentraUserId} = await resolveWorkosUser(identity({email: "frank@example.test"}))
    expect(mentraUserId).toBe("mu_frank")

    // The membership Frank already had is untouched: the pending row's role is lower.
    expect(await WorkspaceMembershipModel.findOne({membershipId: held.membershipId}).lean()).toMatchObject({
      mentraUserId: "mu_frank",
      status: "active",
      role: "admin",
    })
    // No role changed, but a row ended, so the workspace was still written once (revision 0 -> 1).
    expect((await WorkspaceModel.findOne({workspaceId: "ws_1"}).lean())?.authorizationRevision).toBe(1)
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
      before: {role: "developer", keptRole: "admin", keptMembershipId: held.membershipId},
      after: {status: "ended", endedReason: "removed", keptMembershipId: held.membershipId, resultingRole: "admin"},
    })
    expect(events[0]!.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(events[0]!.occurredAt).toBeInstanceOf(Date)
  })

  test("a duplicate's keys are repointed to the surviving membership, so migrated keys stay valid", async () => {
    directoryUsers = [{id: "gotrue-gina", email: "gina@example.test", confirmed: true}]
    await UserModel.create({mentraUserId: "mu_gina", tenantId: "mentra", tenantUserId: "gotrue-gina"})
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One"})
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: "mu_gina", role: "developer"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "developer",
      organizationId: "acme",
    })
    const other = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_other",
      role: "developer",
    })
    const migrated = await seedCredential({workspaceId: "ws_1", createdByMembershipId: duplicate.membershipId})
    const alsoMigrated = await seedCredential({workspaceId: "ws_1", createdByMembershipId: duplicate.membershipId})
    const revoked = await seedCredential({
      workspaceId: "ws_1",
      createdByMembershipId: duplicate.membershipId,
      revokedAt: new Date("2026-02-01T00:00:00Z"),
    })
    const someoneElses = await seedCredential({workspaceId: "ws_1", createdByMembershipId: other.membershipId})
    // Valid while the creator is still a pending membership.
    expect(await validateCredentialToken(migrated.token)).not.toBeNull()

    await resolveWorkosUser(identity({email: "gina@example.test"}))

    // The pending row ended, yet the keys still validate: they now point at the surviving row.
    expect(await WorkspaceMembershipModel.findOne({membershipId: duplicate.membershipId}).lean()).toMatchObject({
      status: "ended",
    })
    for (const key of [migrated, alsoMigrated]) {
      expect(await AccessCredentialModel.findOne({credentialId: key.credentialId}).lean()).toMatchObject({
        createdByMembershipId: held.membershipId,
        revokedAt: null,
      })
      expect(await validateCredentialToken(key.token)).toMatchObject({
        credentialId: key.credentialId,
        workspaceId: "ws_1",
        scopes: ["miniapps.publish"],
      })
    }
    // Revoked keys stay as they were, and other people's keys are untouched.
    expect(await AccessCredentialModel.findOne({credentialId: revoked.credentialId}).lean()).toMatchObject({
      createdByMembershipId: duplicate.membershipId,
    })
    expect(await AccessCredentialModel.findOne({credentialId: someoneElses.credentialId}).lean()).toMatchObject({
      createdByMembershipId: other.membershipId,
    })
    expect(await validateCredentialToken(someoneElses.token)).not.toBeNull()

    const [event] = await WorkspaceAuditEventModel.find({action: "membership.merged_duplicate"}).lean()
    expect(event!.after.keptMembershipId).toBe(held.membershipId)
    expect([...event!.after.repointedCredentialIds].sort()).toEqual(
      [migrated.credentialId, alsoMigrated.credentialId].sort(),
    )
  })

  test("a key created by a pending membership that is simply claimed keeps validating", async () => {
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One"})
    const pending = await seedMembership({workspaceId: "ws_1", pendingWorkosUserId: "user_workos_1", role: "developer"})
    const key = await seedCredential({workspaceId: "ws_1", createdByMembershipId: pending.membershipId})
    expect(await validateCredentialToken(key.token)).not.toBeNull()

    const {mentraUserId} = await resolveWorkosUser(identity())

    // No duplicate: the row is claimed in place, so the key's membership id is unchanged and still active.
    expect(await WorkspaceMembershipModel.findOne({membershipId: pending.membershipId}).lean()).toMatchObject({
      mentraUserId,
      status: "active",
    })
    expect(await AccessCredentialModel.findOne({credentialId: key.credentialId}).lean()).toMatchObject({
      createdByMembershipId: pending.membershipId,
    })
    expect(await validateCredentialToken(key.token)).not.toBeNull()
  })

  test("a repointed key follows the surviving membership's role", async () => {
    const first = await resolveWorkosUser(identity())
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One"})
    // The held row is only a member, but the pending row (and its key) belonged to a developer.
    await seedMembership({workspaceId: "ws_1", mentraUserId: first.mentraUserId, role: "member"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "developer",
      organizationId: "acme",
    })
    const key = await seedCredential({workspaceId: "ws_1", createdByMembershipId: duplicate.membershipId})

    await resolveWorkosUser(identity())

    // The merge raised the surviving row to developer, so the key keeps publishing.
    expect(await validateCredentialToken(key.token)).toMatchObject({scopes: ["miniapps.publish"]})
  })

  test("a duplicate never drops a higher role: pending owner over a held member leaves an owner", async () => {
    directoryUsers = [{id: "gotrue-lena", email: "lena@example.test", confirmed: true}]
    await UserModel.create({mentraUserId: "mu_lena", tenantId: "mentra", tenantUserId: "gotrue-lena"})
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One", authorizationRevision: 4})
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: "mu_lena", role: "member"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "owner",
      organizationId: "acme",
    })

    await resolveWorkosUser(identity({email: "lena@example.test"}))

    expect(await WorkspaceMembershipModel.findOne({membershipId: held.membershipId}).lean()).toMatchObject({
      mentraUserId: "mu_lena",
      status: "active",
      role: "owner",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: duplicate.membershipId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    // The workspace still has exactly one active owner, and authorization caches are invalidated.
    const activeOwners = {workspaceId: "ws_1", role: "owner", status: "active"}
    expect(await WorkspaceMembershipModel.countDocuments(activeOwners)).toBe(1)
    expect((await WorkspaceModel.findOne({workspaceId: "ws_1"}).lean())?.authorizationRevision).toBe(5)
    const events = await WorkspaceAuditEventModel.find({}).lean()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: "membership.merged_duplicate",
      before: {role: "owner", keptRole: "member"},
      after: {resultingRole: "owner", keptMembershipId: held.membershipId},
    })
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

describe("resolveWorkosUser: claiming on every sign-in", () => {
  test("a pending membership that appears after the link is claimed by the next sign-in", async () => {
    const first = await resolveWorkosUser(identity())
    // A migration lands after the person has already signed in.
    const late = await seedMembership({workspaceId: "ws_late", pendingWorkosUserId: "user_workos_1", role: "admin"})

    const again = await resolveWorkosUser(identity())

    expect(again.mentraUserId).toBe(first.mentraUserId)
    expect(await WorkspaceMembershipModel.findOne({membershipId: late.membershipId}).lean()).toMatchObject({
      mentraUserId: first.mentraUserId,
      pendingWorkosUserId: null,
      status: "active",
      role: "admin",
    })
    expect(await IdentityLinkModel.countDocuments({subject: "user_workos_1"})).toBe(1)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(0)
  })

  test("a duplicate of a held membership is merged on the existing-link path too", async () => {
    const first = await resolveWorkosUser(identity())
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One"})
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: first.mentraUserId, role: "member"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "admin",
      organizationId: "acme",
    })
    const fresh = await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "member"})

    await resolveWorkosUser(identity())

    expect(await WorkspaceMembershipModel.findOne({membershipId: held.membershipId}).lean()).toMatchObject({
      status: "active",
      role: "admin",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: duplicate.membershipId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: fresh.membershipId}).lean()).toMatchObject({
      mentraUserId: first.mentraUserId,
      pendingWorkosUserId: null,
    })
    const events = await WorkspaceAuditEventModel.find({}).lean()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: "membership.merged_duplicate",
      workspaceId: "ws_1",
      after: {resultingRole: "admin", keptMembershipId: held.membershipId},
    })
  })

  test("ending a duplicate always bumps the workspace revision, even when no role is raised", async () => {
    const first = await resolveWorkosUser(identity())
    // Not raised: the pending role is lower in one workspace and equal in the other.
    await WorkspaceModel.create({workspaceId: "ws_1", organizationId: "acme", name: "One", authorizationRevision: 7})
    await WorkspaceModel.create({workspaceId: "ws_2", organizationId: "acme", name: "Two", authorizationRevision: 0})
    const heldAdmin = await seedMembership({workspaceId: "ws_1", mentraUserId: first.mentraUserId, role: "admin"})
    await seedMembership({workspaceId: "ws_1", pendingWorkosUserId: "user_workos_1", role: "member"})
    const heldOwner = await seedMembership({workspaceId: "ws_2", mentraUserId: first.mentraUserId, role: "owner"})
    await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "owner"})

    await resolveWorkosUser(identity())

    // The kept memberships are untouched, but every workspace that lost a row was written once, so a
    // concurrent leave or removal that counts owners conflicts with the merge instead of racing it.
    expect(await WorkspaceMembershipModel.findOne({membershipId: heldAdmin.membershipId}).lean()).toMatchObject({
      status: "active",
      role: "admin",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: heldOwner.membershipId}).lean()).toMatchObject({
      status: "active",
      role: "owner",
    })
    expect((await WorkspaceModel.findOne({workspaceId: "ws_1"}).lean())?.authorizationRevision).toBe(8)
    expect((await WorkspaceModel.findOne({workspaceId: "ws_2"}).lean())?.authorizationRevision).toBe(1)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.merged_duplicate"})).toBe(2)
  })

  test("concurrent sign-ins on an existing link claim each pending row exactly once", async () => {
    const first = await resolveWorkosUser(identity())
    const held = await seedMembership({workspaceId: "ws_1", mentraUserId: first.mentraUserId, role: "member"})
    const duplicate = await seedMembership({
      workspaceId: "ws_1",
      pendingWorkosUserId: "user_workos_1",
      role: "developer",
      organizationId: "acme",
    })
    const fresh = await seedMembership({workspaceId: "ws_2", pendingWorkosUserId: "user_workos_1", role: "member"})

    const results = await Promise.all(Array.from({length: 8}, () => resolveWorkosUser(identity())))

    expect(new Set(results.map(result => result.mentraUserId))).toEqual(new Set([first.mentraUserId]))
    // A double claim would write the audit event twice.
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.merged_duplicate"})).toBe(1)
    expect(await WorkspaceMembershipModel.findOne({membershipId: held.membershipId}).lean()).toMatchObject({
      status: "active",
      role: "developer",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: duplicate.membershipId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: fresh.membershipId}).lean()).toMatchObject({
      mentraUserId: first.mentraUserId,
      pendingWorkosUserId: null,
    })
    const heldInWs1 = {workspaceId: "ws_1", mentraUserId: first.mentraUserId, status: "active"}
    expect(await WorkspaceMembershipModel.countDocuments(heldInWs1)).toBe(1)
  })

  test("a sign-in with nothing pending stays cheap: no transaction is opened", async () => {
    await resolveWorkosUser(identity())
    // Rows that must not trigger a claim: other people's, and this person's ended one.
    await seedMembership({workspaceId: "ws_1", pendingWorkosUserId: "user_workos_other"})
    await seedMembership({
      workspaceId: "ws_2",
      pendingWorkosUserId: "user_workos_1",
      status: "ended",
      endedAt: new Date("2026-02-01T00:00:00Z"),
      endedReason: "removed",
    })
    const startSession = spyOn(IdentityLinkModel.db, "startSession")
    try {
      await resolveWorkosUser(identity())
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      startSession.mockRestore()
    }
  })
})
