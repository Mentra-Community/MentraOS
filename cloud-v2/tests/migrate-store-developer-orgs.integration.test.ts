/**
 * @fileoverview Integration tests for the Store developer-org migration script.
 *
 * The script reads the Store's developer-org collections (the source) and
 * writes Core workspaces, memberships, invitations and credentials (the
 * target). These tests seed a realistic source in one random local database,
 * run the real script against a second random local database, and check what
 * was written, what was left alone, and what the report says.
 *
 * Pinned here: a dry run writes nothing; apply maps every field as specified;
 * apply twice changes nothing (and records no second audit event); a re-run
 * never overwrites later Core changes, but does carry access removals made in
 * the Store since (revoked keys and invitations, removed members who have not
 * signed in yet) and reports drift it does not change; migrated keys validate
 * before their creator has ever signed in; and `--apply` refuses a remote database.
 *
 * Safety: both URLs come from `localTestMongoUrl` (loopback only, random
 * database names, ignores `MONGO_URL`) and the live connections are asserted
 * to be on those databases before any destructive call. The one subprocess
 * test that passes a remote URL uses a `.invalid` host, which can never
 * resolve, and the script refuses before it opens any connection anyway.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/migrate-store-developer-orgs.integration.test.ts`
 */

import {createHash, randomBytes} from "node:crypto"
import {join} from "node:path"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {
  isLocalMongoUrl,
  MigrationError,
  databaseIdentity,
  migrateStoreDeveloperOrgs,
  openSourceConnection,
  parseArgs,
  UsageError,
} from "../packages/core/scripts/migrate-store-developer-orgs"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {LegacyBrowserIdentityModel} from "../packages/core/src/models/legacy-browser-identity.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {validateCredentialToken} from "../packages/core/src/services/workspaces/credential.service"
import {recoverOwnership} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

// Each apply is several transactions and some tests start subprocesses; a loaded CI machine needs headroom.
setDefaultTimeout(30_000)

const SCRIPT = join(import.meta.dir, "../packages/core/scripts/migrate-store-developer-orgs.ts")

// Typed as one model so the calls the tests share (`find`, `deleteMany`, `init`) type-check on the union.
const TARGET_MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
] as unknown as Array<typeof WorkspaceModel>

const SOURCE_COLLECTIONS = [
  "developer_orgs",
  "developer_org_memberships",
  "developer_org_invitations",
  "developer_org_api_keys",
] as const

const NOW = new Date("2026-10-05T12:00:00.000Z")

const ENV_KEYS = [
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

/** The source's database handle (typed as possibly unset until the connection opens). */
const sourceDb = () => source.db!

let sourceUrl: string
let targetUrl: string
let source: Awaited<ReturnType<typeof openSourceConnection>>
// Set only once both live connections are confirmed to be our random databases;
// every destructive call is gated on it.
let verified = false

// --- Fixture ---------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** An id in ULID form (26 Crockford base32 characters), as the Store mints key ids. */
const ulid = () => Array.from(randomBytes(26), byte => CROCKFORD[byte % 32]).join("")
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")
const at = (iso: string) => new Date(iso)

const ORG_ACME = "dorg_01J8Z3ACME00000000000000A1"
const ORG_BETA = "dorg_01J8Z3BETA00000000000000B2"
const ORG_DELTA = "dorg_01J8Z3DELTA0000000000000D4"
const ORG_GAMMA = "dorg_01J8Z3GAMMA0000000000000C3"
const ORG_UNKNOWN = "dorg_01J8Z3MISSING000000000000X9"

const U = {
  acmeOwner: "user_01J8Z3K6V4W9Q2X5R7T1B0ACME",
  acmeAdmin: "user_01J8Z3K6V4W9Q2X5R7T1B0ADMN",
  acmeDev: "user_01J8Z3K6V4W9Q2X5R7T1B0DEV1",
  acmeUndated: "user_01J8Z3K6V4W9Q2X5R7T1B0UNDT",
  acmeRemoved: "user_01J8Z3K6V4W9Q2X5R7T1B0RMVD",
  ghost: "user_01J8Z3K6V4W9Q2X5R7T1B0GHST",
  betaOwner: "user_01J8Z3K6V4W9Q2X5R7T1B0BOWN",
  betaAdmin: "user_01J8Z3K6V4W9Q2X5R7T1B0BADM",
  deltaCreator: "user_01J8Z3K6V4W9Q2X5R7T1B0DCRT",
  stranger: "user_01J8Z3K6V4W9Q2X5R7T1B0STRG",
}
const STAFF_EMAIL = "staff@store.example"

/** A Store API key with a known secret, so the migrated row can be validated as a bearer token. */
function storeKey(fields: Record<string, unknown>) {
  const keyId = ulid()
  const secret = randomBytes(32).toString("base64url")
  return {
    secret,
    token: `msk_local_${keyId}.${secret}`,
    row: {
      keyId,
      name: "CI key",
      env: "local",
      hash: sha256Hex(secret),
      last4: secret.slice(-4),
      publishingPackage: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: at("2026-02-01T09:00:00.000Z"),
      ...fields,
    },
  }
}

const keys = {
  dev: storeKey({
    orgId: ORG_ACME,
    name: "Dev laptop",
    createdByUserId: U.acmeDev,
    lastUsedAt: at("2026-09-30T08:15:00.000Z"),
    createdAt: at("2026-02-02T09:00:00.000Z"),
  }),
  revoked: storeKey({
    orgId: ORG_ACME,
    name: "Old CI",
    createdByUserId: U.acmeAdmin,
    lastUsedAt: at("2026-03-01T10:00:00.000Z"),
    revokedAt: at("2026-04-01T10:00:00.000Z"),
    createdAt: at("2026-02-03T09:00:00.000Z"),
  }),
  app: storeKey({
    orgId: ORG_ACME,
    name: "Scanner publisher",
    createdByUserId: STAFF_EMAIL,
    publishingPackage: "com.acme.scanner",
    createdAt: at("2026-02-04T09:00:00.000Z"),
  }),
  removedCreator: storeKey({
    orgId: ORG_ACME,
    name: "Left the company",
    createdByUserId: U.acmeRemoved,
  }),
  ghostCreator: storeKey({
    orgId: ORG_ACME,
    name: "Unknown creator",
    createdByUserId: U.ghost,
  }),
  betaOwner: storeKey({
    orgId: ORG_BETA,
    name: "Beta release",
    createdByUserId: U.betaOwner,
    createdAt: at("2026-05-01T09:00:00.000Z"),
  }),
  gammaRevoked: storeKey({
    orgId: ORG_GAMMA,
    name: "Gamma dead key",
    createdByUserId: U.stranger,
    revokedAt: at("2026-06-01T09:00:00.000Z"),
  }),
  orphan: storeKey({orgId: ORG_UNKNOWN, name: "Orphan", createdByUserId: U.stranger}),
}

const invitationIds = {
  acmeAdmin: `dinv_${ulid()}`,
  acmeMember: `dinv_${ulid()}`,
  acmeExpired: `dinv_${ulid()}`,
  acmeRevoked: `dinv_${ulid()}`,
  acmeAccepted: `dinv_${ulid()}`,
  betaOwnerInvite: `dinv_${ulid()}`,
  orphan: `dinv_${ulid()}`,
}
const tokenHashes = Object.fromEntries(Object.keys(invitationIds).map(name => [name, sha256Hex(`invite-${name}`)]))

function invitation(name: keyof typeof invitationIds, fields: Record<string, unknown>) {
  return {
    invitationId: invitationIds[name],
    role: "member",
    tokenHash: tokenHashes[name],
    status: "pending",
    invitedByUserId: U.acmeOwner,
    // Far ahead: the command-line tests run against the wall clock.
    expiresAt: at("2036-10-12T12:00:00.000Z"),
    createdAt: at("2026-10-01T12:00:00.000Z"),
    ...fields,
  }
}

function membership(fields: Record<string, unknown>) {
  return {
    status: "active",
    email: null,
    name: null,
    createdAt: at("2026-01-05T10:00:00.000Z"),
    updatedAt: at("2026-01-05T10:00:00.000Z"),
    ...fields,
  }
}

const SOURCE_ORGS = [
  {
    orgId: ORG_ACME,
    ownerUserId: U.acmeOwner,
    workosOrgId: "org_01J8Z3WORKOSACME",
    displayName: "Acme Robotics",
    packagePrefix: "com.acme",
    packagePrefixStatus: "approved",
    membershipVersion: 7,
    createdAt: at("2026-01-05T10:00:00.000Z"),
    updatedAt: at("2026-08-01T10:00:00.000Z"),
  },
  {
    orgId: ORG_BETA,
    ownerUserId: U.betaOwner,
    displayName: "Beta Labs",
    packagePrefix: "com.beta",
    packagePrefixStatus: "pending",
    membershipVersion: 2,
    createdAt: at("2026-04-10T10:00:00.000Z"),
    updatedAt: at("2026-04-10T10:00:00.000Z"),
  },
  {
    orgId: ORG_GAMMA,
    ownerUserId: null,
    displayName: "Gamma Studio",
    packagePrefix: "com.gamma",
    packagePrefixStatus: "approved",
    membershipVersion: 0,
    createdAt: at("2026-05-10T10:00:00.000Z"),
    updatedAt: at("2026-05-10T10:00:00.000Z"),
  },
  {
    orgId: ORG_DELTA,
    ownerUserId: U.deltaCreator,
    displayName: "Delta Works",
    packagePrefix: "com.delta",
    packagePrefixStatus: "approved",
    membershipVersion: 1,
    createdAt: at("2026-06-10T10:00:00.000Z"),
    updatedAt: at("2026-06-10T10:00:00.000Z"),
  },
]

const SOURCE_MEMBERSHIPS = [
  membership({
    orgId: ORG_ACME,
    userId: U.acmeOwner,
    role: "owner",
    email: "olive@acme.example",
    name: "Olive Owner",
    createdAt: at("2026-01-05T10:00:00.000Z"),
  }),
  membership({
    orgId: ORG_ACME,
    userId: U.acmeAdmin,
    role: "admin",
    email: "adam@acme.example",
    name: "Adam Admin",
    createdAt: at("2026-01-06T10:00:00.000Z"),
  }),
  membership({
    orgId: ORG_ACME,
    userId: U.acmeDev,
    role: "member",
    email: "dev@acme.example",
    createdAt: at("2026-01-07T10:00:00.000Z"),
  }),
  // No createdAt: startedAt falls back to the migration time.
  {orgId: ORG_ACME, userId: U.acmeUndated, role: "member", status: "active", email: null, name: null},
  membership({orgId: ORG_ACME, userId: U.acmeRemoved, role: "member", status: "removed", email: "gone@acme.example"}),
  // Two active rows for one person (the Store's unique index would normally prevent it).
  membership({
    orgId: ORG_BETA,
    userId: U.betaAdmin,
    role: "member",
    email: "bea@beta.example",
    createdAt: at("2026-04-11T10:00:00.000Z"),
  }),
  membership({
    orgId: ORG_BETA,
    userId: U.betaAdmin,
    role: "admin",
    email: "bea@beta.example",
    name: "Bea Admin",
    createdAt: at("2026-04-12T10:00:00.000Z"),
  }),
  // The creator pointer names a person who now holds a lower role.
  membership({
    orgId: ORG_DELTA,
    userId: U.deltaCreator,
    role: "admin",
    email: "dana@delta.example",
    name: "Dana",
    createdAt: at("2026-06-10T10:00:00.000Z"),
  }),
  membership({orgId: ORG_UNKNOWN, userId: U.stranger, role: "owner"}),
]

const SOURCE_INVITATIONS = [
  invitation("acmeAdmin", {orgId: ORG_ACME, email: "new.admin@acme.example", role: "admin"}),
  invitation("acmeMember", {orgId: ORG_ACME, email: "new.dev@acme.example", invitedByUserId: U.ghost}),
  invitation("acmeExpired", {
    orgId: ORG_ACME,
    email: "late@acme.example",
    expiresAt: at("2026-09-01T12:00:00.000Z"),
  }),
  invitation("acmeRevoked", {orgId: ORG_ACME, email: "revoked@acme.example", status: "revoked"}),
  invitation("acmeAccepted", {orgId: ORG_ACME, email: "accepted@acme.example", status: "accepted"}),
  invitation("betaOwnerInvite", {orgId: ORG_BETA, email: "friend@beta.example", invitedByUserId: U.betaOwner}),
  invitation("orphan", {orgId: ORG_UNKNOWN, email: "orphan@example.test"}),
]

const SOURCE_KEYS = [
  keys.dev,
  keys.revoked,
  keys.app,
  keys.removedCreator,
  keys.ghostCreator,
  keys.betaOwner,
  keys.gammaRevoked,
  keys.orphan,
].map(key => key.row)

async function seedSource() {
  await sourceDb()
    .collection("developer_orgs")
    .insertMany(SOURCE_ORGS.map(org => ({...org})))
  await sourceDb()
    .collection("developer_org_memberships")
    .insertMany(SOURCE_MEMBERSHIPS.map(row => ({...row})))
  await sourceDb()
    .collection("developer_org_invitations")
    .insertMany(SOURCE_INVITATIONS.map(row => ({...row})))
  await sourceDb()
    .collection("developer_org_api_keys")
    .insertMany(SOURCE_KEYS.map(row => ({...row})))
}

/** Everything in the source database, for proving the script never changed it. */
async function snapshotSource() {
  const collections = (await sourceDb().listCollections().toArray()).map(entry => entry.name).sort()
  const documents = Object.fromEntries(
    await Promise.all(
      SOURCE_COLLECTIONS.map(
        async name => [name, await sourceDb().collection(name).find({}).sort({_id: 1}).toArray()] as const,
      ),
    ),
  )
  return {collections, documents}
}

async function snapshotTarget() {
  return Object.fromEntries(
    await Promise.all(
      TARGET_MODELS.map(async model => [model.modelName, await model.find({}).sort({_id: 1}).lean()] as const),
    ),
  )
}

async function targetCounts() {
  return Object.fromEntries(
    await Promise.all(TARGET_MODELS.map(async model => [model.modelName, await model.countDocuments({})] as const)),
  )
}

/** The `_id` MongoDB assigned to a seeded source membership row, as the 24-character hex string. */
/** How many active owner memberships `workspaceId` has, claimed or still waiting for their person. */
async function activeOwnerMemberships(workspaceId: string): Promise<number> {
  return WorkspaceMembershipModel.countDocuments({workspaceId, role: "owner", status: "active"})
}

async function sourceMembershipHex(sourceUserId: string, orgId: string, role: string): Promise<string> {
  const row = await sourceDb()
    .collection("developer_org_memberships")
    .findOne({orgId, userId: sourceUserId, role, status: {$ne: "removed"}})
  if (!row) throw new Error(`no source membership ${sourceUserId}/${role} in ${orgId}`)
  return String(row._id)
}

/** Run `fn` with a separate read-only connection to the target, as a dry run on the command line gets. */
async function withReadOnlyTarget<T>(fn: (target: Awaited<ReturnType<typeof openSourceConnection>>) => Promise<T>) {
  const target = await openSourceConnection(targetUrl)
  try {
    assertConnectedTo(targetUrl, target.name)
    return await fn(target)
  } finally {
    await target.close()
  }
}

function run(overrides: Partial<Parameters<typeof migrateStoreDeveloperOrgs>[0]> = {}) {
  return migrateStoreDeveloperOrgs({source, apply: false, now: NOW, ...overrides})
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

function thrownSync(fn: () => unknown): any {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

beforeAll(async () => {
  sourceUrl = localTestMongoUrl("store-source")
  targetUrl = localTestMongoUrl("core-target")
  await connectMongo(targetUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(targetUrl, WorkspaceModel.db.name)
  source = await openSourceConnection(sourceUrl)
  assertConnectedTo(sourceUrl, source.name)
  verified = true
  await Promise.all(TARGET_MODELS.map(model => model.init()))
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(targetUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  if (verified && source.readyState === 1) {
    assertConnectedTo(sourceUrl, source.name)
    await source.dropDatabase()
  }
  await source?.close()
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(targetUrl, WorkspaceModel.db.name)
  assertConnectedTo(sourceUrl, source.name)
  await Promise.all([...TARGET_MODELS, UserModel, LegacyBrowserIdentityModel].map(model => (model as typeof WorkspaceModel).deleteMany({})))
  for (const name of SOURCE_COLLECTIONS) await sourceDb().collection(name).deleteMany({})
  await seedSource()
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

// --- Dry run ---------------------------------------------------------------

describe("dry run", () => {
  test("reports what would be imported and writes nothing to the target or the source", async () => {
    const sourceBefore = await snapshotSource()

    const report = await run()

    expect(report).toEqual({
      mode: "dry-run",
      counts: {orgs: 4, memberships: 7, invitations: 3, credentials: 4, skippedKeys: 3},
      keysWithoutCreator: [
        {orgId: ORG_ACME, keyId: keys.removedCreator.row.keyId, name: "Left the company"},
        {orgId: ORG_ACME, keyId: keys.ghostCreator.row.keyId, name: "Unknown creator"},
        {orgId: ORG_GAMMA, keyId: keys.gammaRevoked.row.keyId, name: "Gamma dead key"},
      ],
      malformedKeys: [],
      ownerlessOrgs: [ORG_GAMMA],
      synthesizedOwners: [ORG_BETA],
      promotedOwners: [ORG_DELTA],
      duplicateMemberships: [{orgId: ORG_BETA, userId: U.betaAdmin}],
      targetCompared: false,
      skippedWorkspaces: [],
      workspaceProfiles: [],
      revokedCredentials: [],
      removedMemberships: [],
      demotedMemberships: [],
      roleDrift: [],
      invitationConflicts: [],
      revokedInvitations: [],
      claimedMembershipDrift: [],
      pendingCollisions: [],
      keptLastOwners: [],
    })

    expect(await targetCounts()).toEqual({
      Workspace: 0,
      WorkspaceMembership: 0,
      WorkspaceInvitation: 0,
      AccessCredential: 0,
      WorkspaceAuditEvent: 0,
    })
    expect(await snapshotSource()).toEqual(sourceBefore)
  })
})

// --- Apply -----------------------------------------------------------------

describe("apply", () => {
  test("reports the same thing as the dry run, with mode apply", async () => {
    const dry = await withReadOnlyTarget(target => run({target}))
    expect(dry.targetCompared).toBe(true)
    const applied = await run({apply: true})
    expect(applied).toEqual({...dry, mode: "apply"})
  })

  test("never modifies the source", async () => {
    const sourceBefore = await snapshotSource()
    await run({apply: true})
    expect(await snapshotSource()).toEqual(sourceBefore)
  })

  test("writes one workspace per developer org, keyed on the original org id", async () => {
    await run({apply: true})

    const workspaces = await WorkspaceModel.find({}).sort({workspaceId: 1}).lean()
    expect(workspaces.map(row => row.workspaceId)).toEqual([ORG_ACME, ORG_BETA, ORG_DELTA, ORG_GAMMA])
    expect(workspaces[0]).toMatchObject({
      workspaceId: ORG_ACME,
      name: "Acme Robotics",
      status: "active",
      authorizationRevision: 0,
      createdByMentraUserId: null,
      deletedAt: null,
      createdAt: at("2026-01-05T10:00:00.000Z"),
      updatedAt: at("2026-08-01T10:00:00.000Z"),
    })
  })

  test("maps memberships: ids, roles, WorkOS ids, display fields and start times", async () => {
    await run({apply: true})

    const ownerHex = await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")
    const adminHex = await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")
    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    const undatedHex = await sourceMembershipHex(U.acmeUndated, ORG_ACME, "member")

    const acme = await WorkspaceMembershipModel.find({workspaceId: ORG_ACME}).sort({membershipId: 1}).lean()
    // Only active source rows: the removed member is not imported.
    expect(acme.map(row => row.membershipId).sort()).toEqual(
      [`wm_${ownerHex}`, `wm_${adminHex}`, `wm_${devHex}`, `wm_${undatedHex}`].sort(),
    )
    const byId = Object.fromEntries(acme.map(row => [row.membershipId, row]))
    expect(byId[`wm_${ownerHex}`]).toMatchObject({
      workspaceId: ORG_ACME,
      mentraUserId: null,
      pendingWorkosUserId: U.acmeOwner,
      email: "olive@acme.example",
      role: "owner",
      status: "active",
      startedAt: at("2026-01-05T10:00:00.000Z"),
      endedAt: null,
      endedReason: null,
    })
    expect(byId[`wm_${adminHex}`]).toMatchObject({role: "admin", pendingWorkosUserId: U.acmeAdmin})
    // member -> developer; the email is kept for display. Core memberships carry no display name.
    expect(byId[`wm_${devHex}`]).toMatchObject({
      role: "developer",
      pendingWorkosUserId: U.acmeDev,
      email: "dev@acme.example",
    })
    expect(acme.some(row => "name" in row)).toBe(false)
    // No createdAt in the Store: startedAt is the migration time.
    expect(byId[`wm_${undatedHex}`]!.startedAt).toEqual(NOW)
    expect(byId[`wm_${undatedHex}`]).toMatchObject({role: "developer", email: null})
    // Nobody has signed in yet: every migrated membership is still pending.
    expect(acme.every(row => row.mentraUserId === null)).toBe(true)
    // Each starts its role history with its role, from its start, at the new workspace's revision 0.
    for (const row of acme) {
      expect(row.roleHistory as unknown).toEqual([{role: row.role, from: row.startedAt, authorizationRevision: 0}])
    }
  })

  test("keeps the highest role of a duplicated member", async () => {
    await run({apply: true})

    const adminHex = await sourceMembershipHex(U.betaAdmin, ORG_BETA, "admin")
    const beta = await WorkspaceMembershipModel.find({workspaceId: ORG_BETA, pendingWorkosUserId: U.betaAdmin}).lean()
    expect(beta).toHaveLength(1)
    expect(beta[0]).toMatchObject({membershipId: `wm_${adminHex}`, role: "admin", email: "bea@beta.example"})
  })

  test("synthesizes a pending owner when the creator pointer has no membership", async () => {
    await run({apply: true})

    const owner = await WorkspaceMembershipModel.findOne({membershipId: `wm_owner_${ORG_BETA}`}).lean()
    expect(owner).toMatchObject({
      workspaceId: ORG_BETA,
      mentraUserId: null,
      pendingWorkosUserId: U.betaOwner,
      email: null,
      role: "owner",
      status: "active",
      startedAt: at("2026-04-10T10:00:00.000Z"),
    })
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ORG_BETA, role: "owner"})).toBe(1)
  })

  test("imports an org with no recorded owner as owner-less, without inventing one", async () => {
    await run({apply: true})

    // GAMMA has no members and no recorded owner.
    expect(await WorkspaceModel.countDocuments({workspaceId: ORG_GAMMA})).toBe(1)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ORG_GAMMA})).toBe(0)
  })

  test("promotes the recorded owner when they are an active member with a lower role", async () => {
    const report = await run({apply: true})

    // DELTA has no owner row, and its recorded owner is an admin: they become the owner (R21).
    const adminHex = await sourceMembershipHex(U.deltaCreator, ORG_DELTA, "admin")
    const delta = await WorkspaceMembershipModel.find({workspaceId: ORG_DELTA}).lean()
    expect(delta).toHaveLength(1)
    expect(delta[0]).toMatchObject({
      membershipId: `wm_${adminHex}`,
      pendingWorkosUserId: U.deltaCreator,
      role: "owner",
      email: "dana@delta.example",
    })
    expect(report.promotedOwners).toEqual([ORG_DELTA])
    expect(report.ownerlessOrgs).not.toContain(ORG_DELTA)
    expect(report.synthesizedOwners).not.toContain(ORG_DELTA)
  })

  test("does not bring back a recorded owner whose only Store rows are inactive", async () => {
    const ORG_EPSILON = "dorg_01J8Z3EPSILON000000000000E5"
    await sourceDb()
      .collection("developer_orgs")
      .insertOne({
        orgId: ORG_EPSILON,
        ownerUserId: U.acmeRemoved,
        displayName: "Epsilon Co",
        createdAt: at("2026-07-10T10:00:00.000Z"),
        updatedAt: at("2026-07-10T10:00:00.000Z"),
      })
    await sourceDb()
      .collection("developer_org_memberships")
      .insertMany([
        {orgId: ORG_EPSILON, userId: U.acmeRemoved, role: "owner", status: "removed", email: "gone@epsilon.example"},
        {orgId: ORG_EPSILON, userId: U.stranger, role: "member", status: "active", email: "sam@epsilon.example"},
      ])

    const report = await run({apply: true})

    expect(report.ownerlessOrgs).toEqual([ORG_EPSILON, ORG_GAMMA].sort())
    expect(report.synthesizedOwners).toEqual([ORG_BETA])
    expect(report.promotedOwners).toEqual([ORG_DELTA])
    const epsilon = await WorkspaceMembershipModel.find({workspaceId: ORG_EPSILON}).lean()
    expect(epsilon.map(row => [row.pendingWorkosUserId, row.role])).toEqual([[U.stranger, "developer"]])
    expect(await WorkspaceMembershipModel.countDocuments({pendingWorkosUserId: U.acmeRemoved})).toBe(0)
    // The org itself is still imported.
    expect(await WorkspaceModel.countDocuments({workspaceId: ORG_EPSILON})).toBe(1)
  })

  test("imports only pending, unexpired invitations and maps their inviter", async () => {
    await run({apply: true})

    const ownerHex = await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")
    const acme = await WorkspaceInvitationModel.find({workspaceId: ORG_ACME}).sort({invitationId: 1}).lean()
    expect(acme.map(row => row.invitationId).sort()).toEqual([invitationIds.acmeAdmin, invitationIds.acmeMember].sort())
    const byId = Object.fromEntries(acme.map(row => [row.invitationId, row]))
    expect(byId[invitationIds.acmeAdmin]).toMatchObject({
      workspaceId: ORG_ACME,
      email: "new.admin@acme.example",
      role: "admin",
      tokenHash: tokenHashes.acmeAdmin,
      status: "pending",
      // The import vouches for what the Store had pending, so it stays acceptable whatever Core's own
      // rules say about its inviter; the inviter's membership is linked for display and ends it.
      invitedByAuthority: "system",
      invitedByMembershipId: `wm_${ownerHex}`,
      invitedByMentraUserId: null,
      invitedByEmail: null,
      expiresAt: at("2036-10-12T12:00:00.000Z"),
      acceptedMembershipId: null,
      createdAt: at("2026-10-01T12:00:00.000Z"),
    })
    // member -> developer; an inviter who is not a member leaves the link empty.
    expect(byId[invitationIds.acmeMember]).toMatchObject({
      role: "developer",
      tokenHash: tokenHashes.acmeMember,
      invitedByAuthority: "system",
      invitedByMembershipId: null,
    })
    // An invitation sent by the synthesized owner points at the synthesized membership.
    const beta = await WorkspaceInvitationModel.findOne({invitationId: invitationIds.betaOwnerInvite}).lean()
    expect(beta?.invitedByMembershipId).toBe(`wm_owner_${ORG_BETA}`)
    // Nothing from an org that does not exist.
    expect(await WorkspaceInvitationModel.countDocuments({invitationId: invitationIds.orphan})).toBe(0)
  })

  test("maps credentials and keeps revoked keys with their dates", async () => {
    await run({apply: true})

    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    const adminHex = await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")

    const dev = await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean()
    expect(dev).toMatchObject({
      prefix: "msk",
      credentialKind: "workspace",
      workspaceId: ORG_ACME,
      name: "Dev laptop",
      env: "local",
      hash: keys.dev.row.hash,
      last4: keys.dev.row.last4,
      scopes: ["miniapps.publish"],
      packageNames: [],
      createdByMembershipId: `wm_${devHex}`,
      createdByMentraUserId: null,
      createdByEmail: "dev@acme.example",
      issuedByService: null,
      expiresAt: null,
      lastUsedAt: at("2026-09-30T08:15:00.000Z"),
      revokedAt: null,
      createdAt: at("2026-02-02T09:00:00.000Z"),
    })

    // A revoked key is kept, with the dates it had in the Store.
    const revoked = await AccessCredentialModel.findOne({credentialId: keys.revoked.row.keyId}).lean()
    expect(revoked).toMatchObject({
      createdByMembershipId: `wm_${adminHex}`,
      lastUsedAt: at("2026-03-01T10:00:00.000Z"),
      revokedAt: at("2026-04-01T10:00:00.000Z"),
      createdAt: at("2026-02-03T09:00:00.000Z"),
    })

    // An app-scoped key belongs to the Store service, restricted to its package.
    const app = await AccessCredentialModel.findOne({credentialId: keys.app.row.keyId}).lean()
    expect(app).toMatchObject({
      workspaceId: ORG_ACME,
      scopes: ["miniapps.publish"],
      packageNames: ["com.acme.scanner"],
      issuedByService: "store",
      createdByEmail: STAFF_EMAIL,
      createdByMembershipId: null,
      createdAt: at("2026-02-04T09:00:00.000Z"),
    })

    // A key created by the synthesized owner is bound to the synthesized membership.
    const beta = await AccessCredentialModel.findOne({credentialId: keys.betaOwner.row.keyId}).lean()
    expect(beta?.createdByMembershipId).toBe(`wm_owner_${ORG_BETA}`)
  })

  test("skips keys whose creator has no membership, and keys of unknown orgs", async () => {
    await run({apply: true})

    const ids = (await AccessCredentialModel.find({}).lean()).map(row => row.credentialId).sort()
    expect(ids).toEqual(
      [keys.dev.row.keyId, keys.revoked.row.keyId, keys.app.row.keyId, keys.betaOwner.row.keyId].sort(),
    )
  })

  test("records one workspace.imported audit event per org, as the system", async () => {
    await run({apply: true})

    const events = await WorkspaceAuditEventModel.find({}).sort({eventId: 1}).lean()
    expect(events).toHaveLength(4)
    expect(events.map(event => event.workspaceId).sort()).toEqual([ORG_ACME, ORG_BETA, ORG_DELTA, ORG_GAMMA])
    for (const event of events) {
      expect(event).toMatchObject({
        action: "workspace.imported",
        actor: {kind: "system"},
        target: {workspaceId: event.workspaceId},
      })
    }
    const acme = events.find(event => event.workspaceId === ORG_ACME)!
    expect(acme.after).toEqual({name: "Acme Robotics", created: true, memberships: 4, invitations: 2, credentials: 3})
  })

  test("a migrated key validates before its creator has ever signed in", async () => {
    await run({apply: true})

    // No membership has been claimed: nobody has signed in.
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: {$ne: null}})).toBe(0)

    expect(await validateCredentialToken(keys.dev.token)).toEqual({
      kind: "credential",
      credentialId: keys.dev.row.keyId,
      credentialKind: "workspace",
      workspaceId: ORG_ACME,
      scopes: ["miniapps.publish"],
      packageNames: [],
      label: "Dev laptop",
    })
    expect(await validateCredentialToken(keys.app.token)).toMatchObject({
      credentialId: keys.app.row.keyId,
      workspaceId: ORG_ACME,
      scopes: ["miniapps.publish"],
      packageNames: ["com.acme.scanner"],
    })
    // Bound to the synthesized (still pending) owner membership.
    expect(await validateCredentialToken(keys.betaOwner.token)).toMatchObject({
      workspaceId: ORG_BETA,
      scopes: ["miniapps.publish"],
    })
    // A revoked key stays revoked, and a skipped key does not exist.
    expect(await validateCredentialToken(keys.revoked.token)).toBeNull()
    expect(await validateCredentialToken(keys.ghostCreator.token)).toBeNull()
    expect(await validateCredentialToken(keys.removedCreator.token)).toBeNull()
  })
})

// --- Idempotency -----------------------------------------------------------

describe("re-running apply", () => {
  test("leaves every row, count and audit event exactly as the first run left them", async () => {
    await run({apply: true})
    const first = await snapshotTarget()
    const firstCounts = await targetCounts()

    await run({apply: true})

    expect(await targetCounts()).toEqual(firstCounts)
    expect(await snapshotTarget()).toEqual(first)
    // One audit event per org, not two.
    expect(await WorkspaceAuditEventModel.countDocuments({action: "workspace.imported"})).toBe(4)
  })

  test("never overwrites changes made in Core after the first run", async () => {
    await run({apply: true})

    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    const adminHex = await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")
    const revokedAt = at("2026-10-04T09:00:00.000Z")
    await WorkspaceModel.updateOne({workspaceId: ORG_ACME}, {$set: {name: "Acme Renamed", authorizationRevision: 5}})
    await WorkspaceMembershipModel.updateOne({membershipId: `wm_${devHex}`}, {$set: {role: "admin"}})
    await WorkspaceMembershipModel.updateOne(
      {membershipId: `wm_${adminHex}`},
      {$set: {status: "ended", endedAt: revokedAt, endedReason: "removed"}},
    )
    await AccessCredentialModel.updateOne({credentialId: keys.dev.row.keyId}, {$set: {revokedAt}})
    await WorkspaceInvitationModel.updateOne({invitationId: invitationIds.acmeAdmin}, {$set: {status: "revoked"}})
    const eventsBefore = await WorkspaceAuditEventModel.countDocuments({})

    await run({apply: true})

    expect(await WorkspaceModel.findOne({workspaceId: ORG_ACME}).lean()).toMatchObject({
      name: "Acme Renamed",
      authorizationRevision: 5,
    })
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${devHex}`}).lean()).toMatchObject({role: "admin"})
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${adminHex}`}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    expect((await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean())?.revokedAt).toEqual(
      revokedAt,
    )
    expect(await WorkspaceInvitationModel.findOne({invitationId: invitationIds.acmeAdmin}).lean()).toMatchObject({
      status: "revoked",
    })
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(eventsBefore)
  })

  test("leaves a claimed membership and a repointed credential alone (first sign-in happened between runs)", async () => {
    await run({apply: true})

    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    const adminHex = await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")
    // What first sign-in does: the WorkOS id is replaced by the Mentra user. Then a key is repointed.
    await WorkspaceMembershipModel.updateOne(
      {membershipId: `wm_${devHex}`},
      {$set: {mentraUserId: "mu_dev", pendingWorkosUserId: null}},
    )
    await AccessCredentialModel.updateOne(
      {credentialId: keys.dev.row.keyId},
      {$set: {createdByMembershipId: `wm_${adminHex}`, createdByMentraUserId: "mu_admin"}},
    )
    const before = await snapshotTarget()
    const countsBefore = await targetCounts()

    await run({apply: true})

    expect(await targetCounts()).toEqual(countsBefore)
    expect(await snapshotTarget()).toEqual(before)
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${devHex}`}).lean()).toMatchObject({
      mentraUserId: "mu_dev",
      pendingWorkosUserId: null,
    })
    // No second, pending membership for the person who already signed in.
    expect(await WorkspaceMembershipModel.countDocuments({pendingWorkosUserId: U.acmeDev})).toBe(0)
    expect(await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean()).toMatchObject({
      createdByMembershipId: `wm_${adminHex}`,
      createdByMentraUserId: "mu_admin",
    })
  })

  test("a server that cannot say which cluster it belongs to has no identity, so an apply refuses it", async () => {
    /** A connection whose server answers `hello` with `answer` and cannot read `config.version`. */
    const answering = (answer: Record<string, unknown>) =>
      ({
        name: "store",
        db: {admin: () => ({command: async () => answer})},
        getClient: () => ({
          db: () => ({collection: () => ({findOne: () => Promise.reject(new Error("not authorized on config"))})}),
        }),
      }) as unknown as Parameters<typeof databaseIdentity>[0]
    // A router's process id names the router, not the cluster.
    expect(await databaseIdentity(answering({msg: "isdbgrid", topologyVersion: {processId: "router-1"}}))).toBeNull()
    expect(await databaseIdentity(answering({}))).toBeNull()
    expect(await databaseIdentity(answering({setName: "rs0", hosts: ["B:27017", "a:27017"]}))).toBe("replica-set rs0 a:27017,b:27017/store")
  })

  test("refuses a source that is the target under another spelling of its host, before writing anything", async () => {
    // The same server under its other loopback name. The import's own URL check would catch this pair;
    // here the connections are handed to it directly, so only the servers' identities can tell.
    const alias = targetUrl.startsWith("mongodb://localhost")
      ? targetUrl.replace("mongodb://localhost", "mongodb://127.0.0.1")
      : targetUrl.replace("mongodb://127.0.0.1", "mongodb://localhost")
    expect(alias).not.toBe(targetUrl)
    const sameAsTarget = await openSourceConnection(alias)
    try {
      await expect(migrateStoreDeveloperOrgs({source: sameAsTarget, apply: true, now: NOW})).rejects.toThrow(/same database/)
    } finally {
      await sameAsTarget.close()
    }
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
  })

  test("one org's failure rolls back that org only, and a re-run completes the import", async () => {
    // BETA's invitations fail to write inside BETA's transaction, as a unique index refusing them would.
    const write = WorkspaceInvitationModel.bulkWrite.bind(WorkspaceInvitationModel)
    const failing = spyOn(WorkspaceInvitationModel, "bulkWrite").mockImplementation(((operations: unknown[], options: unknown) => {
      if (JSON.stringify(operations).includes(invitationIds.betaOwnerInvite)) throw new Error("E11000 duplicate key (injected)")
      return write(operations as never, options as never)
    }) as never)
    let err: Error
    try {
      err = await thrown(() => run({apply: true}))
    } finally {
      failing.mockRestore()
    }
    expect(err).toBeInstanceOf(MigrationError)
    expect(err.message).toContain(ORG_BETA)

    // ACME (processed first) committed whole; BETA left nothing behind, not even an audit event.
    expect(await WorkspaceModel.find({}).distinct("workspaceId")).toEqual([ORG_ACME])
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ORG_BETA})).toBe(0)
    expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ORG_BETA})).toBe(0)
    expect(await AccessCredentialModel.countDocuments({workspaceId: ORG_BETA})).toBe(0)
    expect(await WorkspaceAuditEventModel.find({}).distinct("workspaceId")).toEqual([ORG_ACME])

    await run({apply: true})

    expect(await WorkspaceModel.countDocuments({})).toBe(4)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "workspace.imported"})).toBe(4)
  })

  test("rejects an unexpected source role instead of guessing, in a dry run too, before any write", async () => {
    await sourceDb()
      .collection("developer_org_memberships")
      .insertOne({orgId: ORG_GAMMA, userId: U.stranger, role: "superuser", status: "active"})

    for (const apply of [false, true]) {
      const err = await thrown(() => run({apply}))
      expect(err).toBeInstanceOf(MigrationError)
      expect(err.message).toContain("superuser")
      expect(err.message).toContain(ORG_GAMMA)
    }
    expect((await targetCounts()).Workspace).toBe(0)
  })
})

// --- Access removals on re-run ---------------------------------------------

describe("re-running apply carries access removals made in the Store", () => {
  /** The rows the re-run is allowed to change, keyed for comparison. */
  const auditActions = async () =>
    (await WorkspaceAuditEventModel.find({}).sort({eventId: 1}).lean()).map(event => ({
      action: event.action,
      workspaceId: event.workspaceId,
      actor: event.actor,
      target: event.target,
    }))

  test("a key revoked in the Store stops validating, and the dry run reports it first without writing", async () => {
    await run({apply: true})
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()

    const revokedAt = at("2026-10-05T09:00:00.000Z")
    await sourceDb()
      .collection("developer_org_api_keys")
      .updateOne({keyId: keys.dev.row.keyId}, {$set: {revokedAt}})

    const before = await snapshotTarget()
    const dry = await withReadOnlyTarget(target => run({target}))
    expect(dry.targetCompared).toBe(true)
    expect(dry.revokedCredentials).toEqual([{orgId: ORG_ACME, credentialId: keys.dev.row.keyId}])
    expect(await snapshotTarget()).toEqual(before)
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()

    const applied = await run({apply: true})
    expect(applied).toEqual({...dry, mode: "apply"})
    expect(await validateCredentialToken(keys.dev.token)).toBeNull()
    expect((await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean())?.revokedAt).toEqual(
      revokedAt,
    )
    const revokedEvents = await WorkspaceAuditEventModel.find({action: "credential.revoked"}).lean()
    expect(revokedEvents).toHaveLength(1)
    expect(revokedEvents[0]).toMatchObject({
      workspaceId: ORG_ACME,
      actor: {kind: "system"},
      target: {credentialId: keys.dev.row.keyId, workspaceId: ORG_ACME},
    })
    // Revoking a key does not invalidate everyone's pending role change.
    expect((await WorkspaceModel.findOne({workspaceId: ORG_ACME}).lean())?.authorizationRevision).toBe(0)

    // Nothing left to carry: a third run changes nothing and reports nothing.
    const settled = await snapshotTarget()
    const third = await run({apply: true})
    expect(third.revokedCredentials).toEqual([])
    expect(await snapshotTarget()).toEqual(settled)
  })

  test("a member removed in the Store before signing in is removed in Core, with their keys", async () => {
    await run({apply: true})
    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()

    await sourceDb()
      .collection("developer_org_memberships")
      .updateOne({orgId: ORG_ACME, userId: U.acmeDev}, {$set: {status: "removed"}})
    // A source row that disappeared altogether counts as removed too.
    await sourceDb().collection("developer_org_memberships").deleteOne({orgId: ORG_ACME, userId: U.acmeUndated})
    const undated = await WorkspaceMembershipModel.findOne({pendingWorkosUserId: U.acmeUndated}).lean()

    const report = await run({apply: true})

    expect(report.removedMemberships).toEqual(
      [
        {
          orgId: ORG_ACME,
          membershipId: `wm_${devHex}`,
          replacedByMembershipId: null,
          movedCredentialIds: [],
          revokedCredentialIds: [keys.dev.row.keyId],
        },
        {
          orgId: ORG_ACME,
          membershipId: undated!.membershipId,
          replacedByMembershipId: null,
          movedCredentialIds: [],
          revokedCredentialIds: [],
        },
      ].sort((a, b) => (a.membershipId < b.membershipId ? -1 : 1)),
    )
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${devHex}`}).lean()).toMatchObject({
      status: "ended",
      endedReason: "removed",
    })
    expect(await validateCredentialToken(keys.dev.token)).toBeNull()
    // Membership changes bump the revision once, so a pending change in the console has to reload.
    expect((await WorkspaceModel.findOne({workspaceId: ORG_ACME}).lean())?.authorizationRevision).toBe(1)
    const removed = (await auditActions()).filter(event => event.action === "membership.removed")
    expect(removed).toHaveLength(2)
    expect(removed.every(event => event.actor.kind === "system")).toBe(true)
    const devEvent = await WorkspaceAuditEventModel.findOne({
      action: "membership.removed",
      "target.membershipId": `wm_${devHex}`,
    }).lean()
    expect(devEvent?.after).toMatchObject({status: "ended", endedReason: "removed", revokedCredentialIds: [keys.dev.row.keyId]})
  })

  test("a member removed in the Store after signing in is reported, not changed", async () => {
    await run({apply: true})
    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    await WorkspaceMembershipModel.updateOne(
      {membershipId: `wm_${devHex}`},
      {$set: {mentraUserId: "mu_dev", pendingWorkosUserId: null}},
    )
    await sourceDb()
      .collection("developer_org_memberships")
      .updateOne({orgId: ORG_ACME, userId: U.acmeDev}, {$set: {status: "removed"}})
    const before = await snapshotTarget()

    const report = await run({apply: true})

    expect(report.claimedMembershipDrift).toEqual([{orgId: ORG_ACME, membershipId: `wm_${devHex}`, mentraUserId: "mu_dev"}])
    expect(report.removedMemberships).toEqual([])
    expect(await snapshotTarget()).toEqual(before)
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()
  })

  test("an invitation revoked in the Store is revoked in Core", async () => {
    await run({apply: true})
    await sourceDb()
      .collection("developer_org_invitations")
      .updateOne({invitationId: invitationIds.acmeAdmin}, {$set: {status: "revoked"}})

    const report = await run({apply: true})

    expect(report.revokedInvitations).toEqual([{orgId: ORG_ACME, invitationId: invitationIds.acmeAdmin}])
    expect(await WorkspaceInvitationModel.findOne({invitationId: invitationIds.acmeAdmin}).lean()).toMatchObject({
      status: "revoked",
    })
    expect(await WorkspaceAuditEventModel.findOne({action: "invitation.revoked"}).lean()).toMatchObject({
      workspaceId: ORG_ACME,
      actor: {kind: "system"},
      target: {invitationId: invitationIds.acmeAdmin},
    })
  })

  test("a synthesized owner who now has a row of their own, under a new owner, gets that row's membership and role", async () => {
    await run({apply: true})
    const synthesized = `wm_owner_${ORG_BETA}`
    expect(await WorkspaceMembershipModel.findOne({membershipId: synthesized}).lean()).toMatchObject({role: "owner", status: "active"})
    // The Store now lists the recorded owner as a member, and someone new as the owner, whom a verified
    // email can claim (so they count as an owner).
    await LegacyBrowserIdentityModel.create({workosUserId: "user_01J8Z3K6V4W9Q2X5R7T1B0NOWN", email: "new.owner@beta.example"})
    const {insertedId} = await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_BETA, userId: U.betaOwner, role: "member", email: "owner@beta.example"}))
    await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_BETA, userId: "user_01J8Z3K6V4W9Q2X5R7T1B0NOWN", role: "owner", email: "new.owner@beta.example"}))
    const replacement = `wm_${String(insertedId)}`

    const report = await run({apply: true})

    expect(report.pendingCollisions).toEqual([])
    expect(report.removedMemberships).toEqual([
      {
        orgId: ORG_BETA,
        membershipId: synthesized,
        replacedByMembershipId: replacement,
        movedCredentialIds: [keys.betaOwner.row.keyId],
        revokedCredentialIds: [],
      },
    ])
    expect(await WorkspaceMembershipModel.findOne({membershipId: synthesized}).lean()).toMatchObject({status: "ended"})
    expect(await WorkspaceMembershipModel.findOne({membershipId: replacement}).lean()).toMatchObject({
      status: "active",
      role: "developer",
      pendingWorkosUserId: U.betaOwner,
    })
    expect(await validateCredentialToken(keys.betaOwner.token)).not.toBeNull()
  })

  test("when another of a person's active rows comes to rank first, its membership replaces the one imported", async () => {
    await run({apply: true})
    // BETA lists Bea twice (member, then admin): the admin row was imported.
    const adminRow = await sourceMembershipHex(U.betaAdmin, ORG_BETA, "admin")
    const memberRow = await sourceMembershipHex(U.betaAdmin, ORG_BETA, "member")
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${adminRow}`}).lean()).toMatchObject({role: "admin", status: "active"})
    // The imported row is lowered to member and the other raised to admin: the other now ranks first.
    const rows = sourceDb().collection("developer_org_memberships")
    const beas = await rows.find({orgId: ORG_BETA, userId: U.betaAdmin}).toArray()
    const byHex = new Map(beas.map(row => [String(row._id), row._id]))
    await rows.updateOne({_id: byHex.get(adminRow)}, {$set: {role: "member"}})
    await rows.updateOne({_id: byHex.get(memberRow)}, {$set: {role: "admin"}})

    const report = await run({apply: true})

    expect(report.pendingCollisions).toEqual([])
    expect(report.removedMemberships).toEqual([
      {orgId: ORG_BETA, membershipId: `wm_${adminRow}`, replacedByMembershipId: `wm_${memberRow}`, movedCredentialIds: [], revokedCredentialIds: []},
    ])
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${adminRow}`}).lean()).toMatchObject({status: "ended"})
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${memberRow}`}).lean()).toMatchObject({
      status: "active",
      role: "admin",
      pendingWorkosUserId: U.betaAdmin,
    })
  })

  test("when the first-ranked row flips back to one whose membership was replaced, the person keeps the membership they have", async () => {
    await run({apply: true})
    const adminRow = await sourceMembershipHex(U.betaAdmin, ORG_BETA, "admin")
    const memberRow = await sourceMembershipHex(U.betaAdmin, ORG_BETA, "member")
    const rows = sourceDb().collection("developer_org_memberships")
    const beas = await rows.find({orgId: ORG_BETA, userId: U.betaAdmin}).toArray()
    const byHex = new Map(beas.map(row => [String(row._id), row._id]))
    const swap = async (adminHex: string, memberHex: string) => {
      await rows.updateOne({_id: byHex.get(adminHex)}, {$set: {role: "admin"}})
      await rows.updateOne({_id: byHex.get(memberHex)}, {$set: {role: "member"}})
    }
    await swap(memberRow, adminRow)
    await run({apply: true})
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${memberRow}`}).lean()).toMatchObject({status: "active"})

    // The first row ranks first again, but its membership has ended: Core never revives one.
    await swap(adminRow, memberRow)
    const report = await run({apply: true})

    expect(report.removedMemberships).toEqual([])
    expect(report.pendingCollisions).toEqual([])
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${memberRow}`}).lean()).toMatchObject({
      status: "active",
      role: "admin",
      pendingWorkosUserId: U.betaAdmin,
    })
  })

  test("a newer Store invitation for the same email replaces the one imported earlier, even while both are pending in the Store", async () => {
    await run({apply: true})
    const newer = `dinv_${ulid()}`
    await sourceDb()
      .collection("developer_org_invitations")
      .insertOne({
        ...invitation("acmeAdmin", {orgId: ORG_ACME, email: "New.Admin@acme.example", role: "admin"}),
        invitationId: newer,
        tokenHash: sha256Hex("invite-newer"),
        createdAt: at("2026-10-06T12:00:00.000Z"),
      })

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(report).toEqual({...dry, mode: "apply"})
    expect(report.revokedInvitations).toEqual([{orgId: ORG_ACME, invitationId: invitationIds.acmeAdmin}])
    expect(await WorkspaceInvitationModel.findOne({invitationId: invitationIds.acmeAdmin}).lean()).toMatchObject({status: "revoked"})
    expect(await WorkspaceInvitationModel.findOne({invitationId: newer}).lean()).toMatchObject({
      status: "pending",
      email: "new.admin@acme.example",
    })
  })

  test("a pending invitation made in Core keeps its email: the Store's for the same address is reported, not imported", async () => {
    const first = await run({apply: true})
    await WorkspaceInvitationModel.create({
      invitationId: "winv_made_in_core",
      workspaceId: ORG_ACME,
      email: "late.joiner@acme.example",
      role: "developer",
      tokenHash: sha256Hex("invite-core"),
      status: "pending",
      invitedByAuthority: "system",
      expiresAt: at("2036-10-12T12:00:00.000Z"),
    })
    const fromStore = `dinv_${ulid()}`
    await sourceDb()
      .collection("developer_org_invitations")
      .insertOne({
        ...invitation("acmeMember", {orgId: ORG_ACME, email: "late.joiner@acme.example"}),
        invitationId: fromStore,
        tokenHash: sha256Hex("invite-late"),
      })

    const report = await run({apply: true})

    expect(report.invitationConflicts).toEqual([{orgId: ORG_ACME, invitationId: fromStore, keptInvitationId: "winv_made_in_core"}])
    // Not counted as imported.
    expect(report.counts.invitations).toBe(first.counts.invitations)
    expect(report.revokedInvitations).toEqual([])
    expect(await WorkspaceInvitationModel.findOne({invitationId: fromStore}).lean()).toBeNull()
    expect(await WorkspaceInvitationModel.findOne({invitationId: "winv_made_in_core"}).lean()).toMatchObject({status: "pending"})
  })

  test("a person removed and re-added in the Store gets their new membership in place of the old one, keeping their keys and invitations", async () => {
    // The person sent an invitation that is still pending in the Store.
    await sourceDb()
      .collection("developer_org_invitations")
      .updateOne({invitationId: invitationIds.acmeAdmin}, {$set: {invitedByUserId: U.acmeDev}})
    await run({apply: true})
    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()
    await sourceDb()
      .collection("developer_org_memberships")
      .updateOne({orgId: ORG_ACME, userId: U.acmeDev}, {$set: {status: "removed"}})
    const {insertedId} = await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_ACME, userId: U.acmeDev, role: "admin", email: "dev@acme.example"}))
    const replacementId = `wm_${String(insertedId)}`
    const removal = {
      orgId: ORG_ACME,
      membershipId: `wm_${devHex}`,
      replacedByMembershipId: replacementId,
      movedCredentialIds: [keys.dev.row.keyId],
      revokedCredentialIds: [],
    }

    const dry = await withReadOnlyTarget(target => run({target}))
    expect(dry.removedMemberships).toEqual([removal])
    const report = await run({apply: true})
    expect(report).toEqual({...dry, mode: "apply"})

    expect(report.pendingCollisions).toEqual([])
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${devHex}`}).lean()).toMatchObject({
      status: "ended",
    })
    const readded = (await WorkspaceMembershipModel.findOne({membershipId: replacementId}).lean())!
    expect(readded).toMatchObject({
      status: "active",
      role: "admin",
      pendingWorkosUserId: U.acmeDev,
    })
    // Imported into an existing workspace: its role history starts at the revision the re-run left.
    const revision = (await WorkspaceModel.findOne({workspaceId: ORG_ACME}).lean())!.authorizationRevision
    expect(revision).toBeGreaterThan(0)
    expect(readded.roleHistory as unknown).toEqual([{role: "admin", from: readded.startedAt, authorizationRevision: revision}])

    // The key the Store still has live keeps working, now under the new membership, and the
    // person's pending invitation stays acceptable.
    expect(await validateCredentialToken(keys.dev.token)).not.toBeNull()
    expect(await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean()).toMatchObject({
      createdByMembershipId: replacementId,
      revokedAt: null,
    })
    expect(await WorkspaceInvitationModel.findOne({invitationId: invitationIds.acmeAdmin}).lean()).toMatchObject({
      status: "pending",
      invitedByMembershipId: replacementId,
    })
    const replaced = await WorkspaceAuditEventModel.findOne({
      action: "membership.replaced",
      "target.membershipId": `wm_${devHex}`,
    }).lean()
    expect(replaced?.actor).toEqual({kind: "system"})
    expect(replaced?.after).toEqual({
      replacedByMembershipId: replacementId,
      repointedCredentialIds: [keys.dev.row.keyId],
      repointedInvitationIds: [invitationIds.acmeAdmin],
    })
    const removedEvent = await WorkspaceAuditEventModel.findOne({
      action: "membership.removed",
      "target.membershipId": `wm_${devHex}`,
    }).lean()
    expect(removedEvent?.after).toMatchObject({revokedCredentialIds: [], revokedInvitationIds: []})

    // Settled: a third run changes nothing.
    const settled = await snapshotTarget()
    const third = await run({apply: true})
    expect(third.removedMemberships).toEqual([])
    expect(await snapshotTarget()).toEqual(settled)
  })

  test("a key the Store revoked is not moved to the replacement membership", async () => {
    await run({apply: true})
    const devHex = await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")
    const revokedAt = at("2026-10-05T09:00:00.000Z")
    await sourceDb().collection("developer_org_api_keys").updateOne({keyId: keys.dev.row.keyId}, {$set: {revokedAt}})
    await sourceDb()
      .collection("developer_org_memberships")
      .updateOne({orgId: ORG_ACME, userId: U.acmeDev}, {$set: {status: "removed"}})
    const {insertedId} = await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_ACME, userId: U.acmeDev, role: "member", email: "dev@acme.example"}))

    const report = await run({apply: true})

    expect(report.revokedCredentials).toEqual([{orgId: ORG_ACME, credentialId: keys.dev.row.keyId}])
    expect(report.removedMemberships).toEqual([
      {
        orgId: ORG_ACME,
        membershipId: `wm_${devHex}`,
        replacedByMembershipId: `wm_${String(insertedId)}`,
        movedCredentialIds: [],
        revokedCredentialIds: [],
      },
    ])
    expect(await validateCredentialToken(keys.dev.token)).toBeNull()
    expect(await AccessCredentialModel.findOne({credentialId: keys.dev.row.keyId}).lean()).toMatchObject({
      createdByMembershipId: `wm_${devHex}`,
      revokedAt,
    })
  })

  test("a membership that collides with an unclaimed one is reported and the rest of the org still imports", async () => {
    // A Core row already holds BETA's creator as a pending member under another id. Core keeps one active
    // pending membership per person per workspace (checked here, inside the org's transaction: there is
    // no unique index to refuse it), so the synthesized owner is not imported.
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_preexisting",
        workspaceId: ORG_BETA,
        pendingWorkosUserId: U.betaOwner,
        role: "member",
        status: "active",
        startedAt: NOW,
      }),
    )

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    const collision = {
      orgId: ORG_BETA,
      membershipId: `wm_owner_${ORG_BETA}`,
      userId: U.betaOwner,
      skippedCredentialIds: [keys.betaOwner.row.keyId],
    }
    expect(dry.pendingCollisions).toEqual([collision])
    expect(report).toEqual({...dry, mode: "apply"})
    // The skipped membership and its key are not counted as imported; the key is a skipped key.
    expect(report.counts).toEqual({orgs: 4, memberships: 6, invitations: 3, credentials: 3, skippedKeys: 4})
    expect(await WorkspaceMembershipModel.countDocuments({pendingWorkosUserId: U.betaOwner, status: "active"})).toBe(1)
    expect(await WorkspaceModel.find({}).distinct("workspaceId")).toEqual([ORG_ACME, ORG_BETA, ORG_DELTA, ORG_GAMMA])
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ORG_BETA, status: "active"})).toBe(2)
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_owner_${ORG_BETA}`}).lean()).toBeNull()
    expect(await AccessCredentialModel.findOne({credentialId: keys.betaOwner.row.keyId}).lean()).toBeNull()
    // The row the migration did not create is left alone.
    expect(await WorkspaceMembershipModel.findOne({membershipId: "wm_preexisting"}).lean()).toMatchObject({
      status: "active",
    })
  })

  test("a workspace deleted in Core is skipped and reported, and its keys stop validating", async () => {
    await run({apply: true})
    await WorkspaceModel.updateOne({workspaceId: ORG_ACME}, {$set: {status: "deleted", deletedAt: NOW}})
    const late = storeKey({orgId: ORG_ACME, name: "Late key", createdByUserId: U.acmeOwner})
    await sourceDb().collection("developer_org_api_keys").insertOne({...late.row})
    await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_ACME, userId: U.stranger, role: "member"}))
    const before = await snapshotTarget()

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(dry.skippedWorkspaces).toEqual([{orgId: ORG_ACME, status: "deleted"}])
    expect(report.skippedWorkspaces).toEqual([{orgId: ORG_ACME, status: "deleted"}])
    expect(await snapshotTarget()).toEqual(before)
    // A service key and a member key of a deleted workspace do not resolve to a principal.
    expect(await validateCredentialToken(keys.app.token)).toBeNull()
    expect(await validateCredentialToken(keys.dev.token)).toBeNull()
  })
})

describe("publishing profiles of workspaces made in Core", () => {
  // Once the Store serves from Core it keeps each workspace's publishing profile in `developer_orgs`
  // under the workspace id, with no owner and no legacy rows.
  const CORE_WORKSPACE = "ws_01J8Z3COREWORKSPACE0000000A"
  const ORG_EMPTY = "dorg_01J8Z3EMPTY0000000000000E1"
  const profile = (orgId: string, prefix: string, name: string) => ({
    orgId,
    packagePrefix: prefix,
    packagePrefixStatus: "unverified",
    displayName: name,
    createdAt: at("2026-10-01T10:00:00.000Z"),
    updatedAt: at("2026-10-01T10:00:00.000Z"),
  })

  test("are listed in workspaceProfiles and left out of everything else; the workspace is untouched", async () => {
    await WorkspaceModel.create({
      workspaceId: CORE_WORKSPACE,
      name: "Made in Core",
      status: "active",
      authorizationRevision: 3,
      createdByMentraUserId: "mu_core_owner",
    })
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_01J8Z3COREOWNER000000000A",
        workspaceId: CORE_WORKSPACE,
        mentraUserId: "mu_core_owner",
        role: "owner",
        status: "active",
        startedAt: NOW,
      }),
    )
    await sourceDb().collection("developer_orgs").insertOne(profile(CORE_WORKSPACE, "com.madeincore", "Made in Core"))
    const before = await snapshotTarget()
    const logs: string[] = []

    const dry = await withReadOnlyTarget(target => run({target, log: message => logs.push(message)}))
    const report = await run({apply: true})

    for (const result of [dry, report]) {
      expect(result.workspaceProfiles).toEqual([CORE_WORKSPACE])
      expect(result.counts.orgs).toBe(4)
      expect(result.ownerlessOrgs).toEqual([ORG_GAMMA])
      expect(result.skippedWorkspaces).toEqual([])
    }
    expect(logs.some(line => line.includes("publishing profiles of workspaces made in Core"))).toBe(true)
    const after = await snapshotTarget()
    const coreRows = (snapshot: typeof before) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(snapshot).map(([name, rows]) => [
            name,
            (rows as Array<Record<string, unknown>>).filter(row => row.workspaceId === CORE_WORKSPACE),
          ]),
        ),
      )
    expect(coreRows(after)).toEqual(coreRows(before))
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: CORE_WORKSPACE})).toBe(0)
  })

  test("without the target a profile cannot be told apart, and an org the import created stays an org", async () => {
    // A legacy org with no owner and nothing in it: imported as an empty owner-less workspace.
    await sourceDb()
      .collection("developer_orgs")
      .insertOne({...profile(ORG_EMPTY, "com.emptyorg", "Empty Org"), ownerUserId: null})
    const first = await run({apply: true})
    expect(first.workspaceProfiles).toEqual([])
    expect(first.ownerlessOrgs).toEqual([ORG_EMPTY, ORG_GAMMA].sort())
    expect(await WorkspaceModel.countDocuments({workspaceId: ORG_EMPTY})).toBe(1)

    // Re-runs still report it: the import created that workspace.
    const again = await withReadOnlyTarget(target => run({target}))
    expect(again.workspaceProfiles).toEqual([])
    expect(again.ownerlessOrgs).toEqual([ORG_EMPTY, ORG_GAMMA].sort())

    // A profile of a workspace made in Core is only recognised with the target.
    await WorkspaceModel.create({
      workspaceId: CORE_WORKSPACE,
      name: "Made in Core",
      status: "active",
      authorizationRevision: 0,
      createdByMentraUserId: "mu_core_owner",
    })
    await sourceDb().collection("developer_orgs").insertOne(profile(CORE_WORKSPACE, "com.madeincore", "Made in Core"))
    expect((await run()).workspaceProfiles).toEqual([])
    expect((await withReadOnlyTarget(target => run({target}))).workspaceProfiles).toEqual([CORE_WORKSPACE])
  })
})

// --- Keys that are not imported ------------------------------------------

describe("keys that are not imported", () => {
  /** Every key id in the report's three skip lists, in order. */
  const reportedKeyIds = (report: Awaited<ReturnType<typeof run>>) => [
    ...report.malformedKeys.map(key => key.keyId),
    ...report.keysWithoutCreator.map(key => key.keyId),
    ...report.pendingCollisions.flatMap(collision => collision.skippedCredentialIds),
  ]

  /** The Store keys of the orgs the report covers (it names no key of a skipped org or an unknown one). */
  async function sourceKeyCount(report: Awaited<ReturnType<typeof run>>) {
    const skipped = new Set(report.skippedWorkspaces.map(entry => entry.orgId))
    const orgs = SOURCE_ORGS.map(org => org.orgId).filter(orgId => !skipped.has(orgId))
    return sourceDb().collection("developer_org_api_keys").countDocuments({orgId: {$in: orgs}})
  }

  test("a key that could never validate is reported once, with why, and never imported", async () => {
    const bad = {
      id: storeKey({orgId: ORG_ACME, name: "Short id", createdByUserId: U.acmeDev, keyId: "not-a-ulid"}),
      lowerId: storeKey({orgId: ORG_ACME, name: "Lowercase id", createdByUserId: U.acmeDev, keyId: ulid().toLowerCase()}),
      noId: storeKey({orgId: ORG_ACME, name: "No id", createdByUserId: U.acmeDev, keyId: undefined}),
      // Malformed hashes no generated id could contain, so the report can be searched for them.
      hash: storeKey({orgId: ORG_ACME, name: "Short hash", createdByUserId: U.acmeDev, hash: "short-hash-abc123"}),
      upperHash: storeKey({
        orgId: ORG_ACME,
        name: "Uppercase hash",
        createdByUserId: U.acmeDev,
        hash: sha256Hex("x").toUpperCase(),
      }),
      env: storeKey({orgId: ORG_ACME, name: "Bad env", createdByUserId: U.acmeDev, env: "Prod_1"}),
      noEnv: storeKey({orgId: ORG_ACME, name: "No env", createdByUserId: U.acmeDev, env: undefined}),
      // Shape is checked for package keys too.
      app: storeKey({orgId: ORG_ACME, name: "Bad package key", createdByUserId: STAFF_EMAIL, publishingPackage: "com.acme.x", hash: "package-hash-zz"}),
      // Malformed and without a creator: it is malformed, and only that.
      ghost: storeKey({orgId: ORG_ACME, name: "Ghost and bad env", createdByUserId: U.ghost, env: "BAD"}),
    }
    await sourceDb()
      .collection("developer_org_api_keys")
      .insertMany(Object.values(bad).map(key => ({...key.row})))
    const reason = {
      id: "malformed_id",
      lowerId: "malformed_id",
      noId: "malformed_id",
      hash: "malformed_hash",
      upperHash: "malformed_hash",
      env: "malformed_env",
      noEnv: "malformed_env",
      app: "malformed_hash",
      ghost: "malformed_env",
    } as const

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(report).toEqual({...dry, mode: "apply"})
    expect(report.malformedKeys).toEqual(
      (Object.keys(bad) as Array<keyof typeof bad>).map(name => ({
        orgId: ORG_ACME,
        keyId: bad[name].row.keyId ?? null,
        name: bad[name].row.name,
        reason: reason[name],
      })),
    )
    // The creator-less list is unchanged: the malformed ghost key is not in it too.
    expect(report.keysWithoutCreator.map(key => key.keyId)).toEqual([
      keys.removedCreator.row.keyId,
      keys.ghostCreator.row.keyId,
      keys.gammaRevoked.row.keyId,
    ])
    expect(report.counts).toEqual({orgs: 4, memberships: 7, invitations: 3, credentials: 4, skippedKeys: 3 + 9})
    // Every key is either imported or reported exactly once.
    const reported = reportedKeyIds(report)
    expect(new Set(reported).size).toBe(reported.length)
    expect(report.counts.skippedKeys).toBe(reported.length)
    expect(report.counts.credentials + report.counts.skippedKeys).toBe(await sourceKeyCount(report))
    expect(await AccessCredentialModel.countDocuments({})).toBe(4)
    expect(await AccessCredentialModel.countDocuments({name: {$in: Object.values(bad).map(key => key.row.name)}})).toBe(0)
    // No secret material: the report names keys by id and name, never by hash.
    const printed = JSON.stringify(report)
    for (const key of [...SOURCE_KEYS, ...Object.values(bad).map(entry => entry.row)]) {
      expect(printed).not.toContain(String(key.hash))
    }
  })

  test("a key bound to a colliding membership is reported with the collision only, a malformed one there as malformed only", async () => {
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_preexisting",
        workspaceId: ORG_BETA,
        mentraUserId: null,
        pendingWorkosUserId: U.betaOwner,
        role: "developer",
        status: "active",
        startedAt: NOW,
      }),
    )
    const malformed = storeKey({orgId: ORG_BETA, name: "Beta bad hash", createdByUserId: U.betaOwner, hash: "nope"})
    await sourceDb().collection("developer_org_api_keys").insertOne({...malformed.row})

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(report).toEqual({...dry, mode: "apply"})
    expect(report.pendingCollisions).toEqual([
      {orgId: ORG_BETA, membershipId: `wm_owner_${ORG_BETA}`, userId: U.betaOwner, skippedCredentialIds: [keys.betaOwner.row.keyId]},
    ])
    expect(report.malformedKeys).toEqual([
      {orgId: ORG_BETA, keyId: malformed.row.keyId, name: "Beta bad hash", reason: "malformed_hash"},
    ])
    expect(report.keysWithoutCreator).toHaveLength(3)
    expect(report.counts).toEqual({orgs: 4, memberships: 6, invitations: 3, credentials: 3, skippedKeys: 3 + 1 + 1})
    const reported = reportedKeyIds(report)
    expect(new Set(reported).size).toBe(reported.length)
    expect(report.counts.skippedKeys).toBe(reported.length)
    expect(report.counts.credentials + report.counts.skippedKeys).toBe(await sourceKeyCount(report))
    expect(await AccessCredentialModel.countDocuments({workspaceId: ORG_BETA})).toBe(0)
  })

  test("a conforming key is not reported", async () => {
    const report = await run()
    expect(report.malformedKeys).toEqual([])
    expect(report.counts.credentials + report.counts.skippedKeys).toBe(await sourceKeyCount(report))
  })
})

// --- Roles changed in the Store --------------------------------------------

describe("re-running apply carries demotions made in the Store", () => {
  const setStoreRole = (orgId: string, userId: string, role: string) =>
    sourceDb().collection("developer_org_memberships").updateMany({orgId, userId, status: {$ne: "removed"}}, {$set: {role}})

  test("a member demoted in the Store before signing in is demoted in Core, audited as the system", async () => {
    await run({apply: true})
    const adminId = `wm_${await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")}`
    await setStoreRole(ORG_ACME, U.acmeAdmin, "member")

    const before = await snapshotTarget()
    const dry = await withReadOnlyTarget(target => run({target}))
    expect(dry.demotedMemberships).toEqual([{orgId: ORG_ACME, membershipId: adminId, fromRole: "admin", toRole: "developer"}])
    expect(dry.roleDrift).toEqual([])
    expect(await snapshotTarget()).toEqual(before)

    const applied = await run({apply: true})
    expect(applied).toEqual({...dry, mode: "apply"})
    const revision = (await WorkspaceModel.findOne({workspaceId: ORG_ACME}).lean())!.authorizationRevision
    expect(revision).toBe(1)
    const demoted = (await WorkspaceMembershipModel.findOne({membershipId: adminId}).lean())!
    expect(demoted.role).toBe("developer")
    expect((demoted.roleHistory as Array<{role: string; authorizationRevision: number}>).map(entry => [entry.role, entry.authorizationRevision])).toEqual([
      ["admin", 0],
      ["developer", revision],
    ])
    const event = await WorkspaceAuditEventModel.findOne({action: "membership.role_changed", "target.membershipId": adminId}).lean()
    expect(event).toMatchObject({actor: {kind: "system"}, before: {role: "admin"}, after: {role: "developer"}})

    // Settled: a third run changes nothing.
    const settled = await snapshotTarget()
    const third = await run({apply: true})
    expect(third.demotedMemberships).toEqual([])
    expect(await snapshotTarget()).toEqual(settled)
  })

  test("a role the Store raised, a role Core changed since, and a signed-in member's role are reported, not changed", async () => {
    await run({apply: true})
    const adminId = `wm_${await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")}`
    const devId = `wm_${await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")}`
    const undated = (await WorkspaceMembershipModel.findOne({pendingWorkosUserId: U.acmeUndated}).lean())!
    // An Organization Admin made the admin an owner in Core (as Core records it: the role, its
    // history and an audit event by that person); then the Store demoted them to member.
    await WorkspaceMembershipModel.updateOne(
      {membershipId: adminId},
      {$set: {role: "owner"}, $push: {roleHistory: {role: "owner", from: NOW, authorizationRevision: 0}}},
    )
    await WorkspaceAuditEventModel.create({
      eventId: ulid(),
      workspaceId: ORG_ACME,
      action: "membership.role_changed",
      actor: {kind: "user", mentraUserId: "mu_org_admin"},
      target: {membershipId: adminId},
      before: {role: "admin"},
      after: {role: "owner"},
      occurredAt: NOW,
    })
    await setStoreRole(ORG_ACME, U.acmeAdmin, "member")
    // The Store raised a member to admin.
    await setStoreRole(ORG_ACME, U.acmeDev, "admin")
    // A member signed in to Core (claimed), then the Store raised them.
    await WorkspaceMembershipModel.updateOne(
      {membershipId: undated.membershipId},
      {$set: {mentraUserId: "mu_UNDATED"}, $unset: {pendingWorkosUserId: 1}},
    )
    await setStoreRole(ORG_ACME, U.acmeUndated, "admin")

    const before = await snapshotTarget()
    const report = await run({apply: true})

    expect(report.demotedMemberships).toEqual([])
    expect(report.roleDrift).toEqual(
      [
        {orgId: ORG_ACME, membershipId: adminId, coreRole: "owner", storeRole: "developer", reason: "changed_in_core"},
        {orgId: ORG_ACME, membershipId: devId, coreRole: "developer", storeRole: "admin", reason: "raised_in_store"},
        {orgId: ORG_ACME, membershipId: undated.membershipId, coreRole: "developer", storeRole: "admin", reason: "claimed"},
      ].sort((a, b) => (a.membershipId < b.membershipId ? -1 : 1)),
    )
    expect(await snapshotTarget()).toEqual(before)
  })

  test("a role the Store lowers in steps across runs is lowered at each run", async () => {
    await run({apply: true})
    const ownerId = `wm_${await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")}`
    // A new owner joins in the Store (a verified email can claim them), and the old one becomes an admin...
    await LegacyBrowserIdentityModel.create({workosUserId: "user_01J8Z3K6V4W9Q2X5R7T1B0NOWN", email: "next@acme.example"})
    await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_ACME, userId: "user_01J8Z3K6V4W9Q2X5R7T1B0NOWN", role: "owner", email: "next@acme.example"}))
    await setStoreRole(ORG_ACME, U.acmeOwner, "admin")
    expect((await run({apply: true})).demotedMemberships).toEqual([
      {orgId: ORG_ACME, membershipId: ownerId, fromRole: "owner", toRole: "admin"},
    ])
    // ...and later a member: the importer's own earlier change is no change made in Core.
    await setStoreRole(ORG_ACME, U.acmeOwner, "member")
    const third = await run({apply: true})
    expect(third.roleDrift).toEqual([])
    expect(third.demotedMemberships).toEqual([{orgId: ORG_ACME, membershipId: ownerId, fromRole: "admin", toRole: "developer"}])
    expect((await WorkspaceMembershipModel.findOne({membershipId: ownerId}).lean())!.role).toBe("developer")
  })

  test("an ownership handed over in the Store keeps the Core owner: the demotion is kept and the promotion reported", async () => {
    await run({apply: true})
    const ownerId = `wm_${await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")}`
    const adminId = `wm_${await sourceMembershipHex(U.acmeAdmin, ORG_ACME, "admin")}`
    await setStoreRole(ORG_ACME, U.acmeOwner, "admin")
    await setStoreRole(ORG_ACME, U.acmeAdmin, "owner")

    const report = await run({apply: true})

    // A run only carries reductions, so the new owner stays an admin in Core, and lowering the old
    // owner would leave the workspace without one.
    expect(report.demotedMemberships).toEqual([])
    expect(report.keptLastOwners).toEqual([{orgId: ORG_ACME, membershipId: ownerId, userId: U.acmeOwner}])
    expect(report.roleDrift).toEqual([
      {orgId: ORG_ACME, membershipId: adminId, coreRole: "admin", storeRole: "owner", reason: "raised_in_store"},
    ])
    expect((await WorkspaceMembershipModel.findOne({membershipId: ownerId}).lean())!.role).toBe("owner")
  })
})

// --- The last owner --------------------------------------------------------

describe("re-running apply never leaves a workspace without an owner", () => {
  const removeInStore = (orgId: string, userId: string) =>
    sourceDb().collection("developer_org_memberships").updateMany({orgId, userId}, {$set: {status: "removed"}})

  test("the last owner, removed in the Store before signing in, is kept and reported; other removals still happen", async () => {
    await run({apply: true})
    const ownerId = `wm_${await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")}`
    const devId = `wm_${await sourceMembershipHex(U.acmeDev, ORG_ACME, "member")}`
    // A key the owner created keeps working while the membership is kept.
    const ownerKey = storeKey({orgId: ORG_ACME, name: "Owner key", createdByUserId: U.acmeOwner})
    await sourceDb().collection("developer_org_api_keys").insertOne({...ownerKey.row})
    await run({apply: true})
    expect(await validateCredentialToken(ownerKey.token)).not.toBeNull()
    await removeInStore(ORG_ACME, U.acmeOwner)
    await removeInStore(ORG_ACME, U.acmeDev)

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(report).toEqual({...dry, mode: "apply"})
    expect(report.keptLastOwners).toEqual([{orgId: ORG_ACME, membershipId: ownerId, userId: U.acmeOwner}])
    expect(report.removedMemberships).toEqual([
      {
        orgId: ORG_ACME,
        membershipId: devId,
        replacedByMembershipId: null,
        movedCredentialIds: [],
        revokedCredentialIds: [keys.dev.row.keyId],
      },
    ])
    expect(await WorkspaceMembershipModel.findOne({membershipId: ownerId}).lean()).toMatchObject({status: "active", role: "owner"})
    expect(await WorkspaceMembershipModel.findOne({membershipId: devId}).lean()).toMatchObject({status: "ended"})
    expect(await activeOwnerMemberships(ORG_ACME)).toBe(1)
    expect(await validateCredentialToken(ownerKey.token)).not.toBeNull()

    // Every run says so again until an Organization Admin decides in Core, and changes nothing more.
    const settled = await snapshotTarget()
    const again = await run({apply: true})
    expect(again.keptLastOwners).toEqual(report.keptLastOwners)
    expect(again.removedMemberships).toEqual([])
    expect(await snapshotTarget()).toEqual(settled)

    // Once Core has another owner, the next run carries the removal.
    await UserModel.create({mentraUserId: "mu_new_owner", tenantId: "mentra", tenantUserId: "new-owner"})
    await recoverOwnership({kind: "system"}, ORG_ACME, "mu_new_owner")
    const after = await run({apply: true})
    expect(after.keptLastOwners).toEqual([])
    expect(after.removedMemberships).toEqual([
      {
        orgId: ORG_ACME,
        membershipId: ownerId,
        replacedByMembershipId: null,
        movedCredentialIds: [],
        revokedCredentialIds: [ownerKey.row.keyId],
      },
    ])
    expect(await activeOwnerMemberships(ORG_ACME)).toBe(1)
    expect(await validateCredentialToken(ownerKey.token)).toBeNull()
  })

  test("a pending owner removed in the Store is ended when another owner remains: signed in, pending, or newly imported", async () => {
    await run({apply: true})
    const acmeOwnerId = `wm_${await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")}`
    const deltaOwnerId = `wm_${await sourceMembershipHex(U.deltaCreator, ORG_DELTA, "admin")}`
    // ACME: a second owner who has signed in. BETA: a second pending owner. DELTA: the Store's new owner.
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_signed_in_owner", workspaceId: ORG_ACME, mentraUserId: "mu_acme_owner2", role: "owner", status: "active", startedAt: NOW}),
    )
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_pending_owner2", workspaceId: ORG_BETA, mentraUserId: null, pendingWorkosUserId: U.stranger, role: "owner", status: "active", startedAt: NOW}),
    )
    // Pending owners count while a verified email can still claim them (the export recorded one).
    await LegacyBrowserIdentityModel.create([
      {workosUserId: U.stranger, email: "stranger@beta.example"},
      {workosUserId: U.acmeAdmin, email: "adam@delta.example"},
    ])
    await removeInStore(ORG_ACME, U.acmeOwner)
    // BETA's synthesized owner is gone once the Store records someone else as its owner.
    await sourceDb().collection("developer_orgs").updateOne({orgId: ORG_BETA}, {$set: {ownerUserId: U.betaAdmin}})
    await removeInStore(ORG_DELTA, U.deltaCreator)
    const {insertedId} = await sourceDb()
      .collection("developer_org_memberships")
      .insertOne(membership({orgId: ORG_DELTA, userId: U.acmeAdmin, role: "owner", email: "adam@delta.example"}))

    const report = await run({apply: true})

    expect(report.keptLastOwners).toEqual([])
    expect(report.removedMemberships.map(entry => [entry.orgId, entry.membershipId]).sort()).toEqual(
      [
        [ORG_ACME, acmeOwnerId],
        [ORG_BETA, `wm_owner_${ORG_BETA}`],
        [ORG_DELTA, deltaOwnerId],
      ].sort(),
    )
    for (const orgId of [ORG_ACME, ORG_BETA, ORG_DELTA]) expect(await activeOwnerMemberships(orgId)).toBe(1)
    expect(await WorkspaceMembershipModel.findOne({membershipId: `wm_${String(insertedId)}`}).lean()).toMatchObject({
      status: "active",
      role: "owner",
      pendingWorkosUserId: U.acmeAdmin,
    })
  })

  test("a pending owner nobody can claim is no owner: removing the last claimable one is kept and reported", async () => {
    await run({apply: true})
    const acmeOwnerId = `wm_${await sourceMembershipHex(U.acmeOwner, ORG_ACME, "owner")}`
    // A second pending owner whose identity was never exported (or was removed): nobody can take it up.
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_unclaimable_owner", workspaceId: ORG_ACME, mentraUserId: null, pendingWorkosUserId: U.stranger, role: "owner", status: "active", startedAt: NOW}),
    )
    await removeInStore(ORG_ACME, U.acmeOwner)

    const report = await run({apply: true})

    expect(report.keptLastOwners).toEqual([{orgId: ORG_ACME, membershipId: acmeOwnerId, userId: U.acmeOwner}])
    expect(await WorkspaceMembershipModel.findOne({membershipId: acmeOwnerId}).lean()).toMatchObject({status: "active"})
  })

  test("a deleted account's owner membership is no owner: the pending owner is kept", async () => {
    await run({apply: true})
    const ownerId = (await WorkspaceMembershipModel.findOne({workspaceId: ORG_ACME, pendingWorkosUserId: U.acmeOwner}).lean())!
      .membershipId
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_gone_owner", workspaceId: ORG_ACME, mentraUserId: "mu_gone", role: "owner", status: "active", startedAt: NOW}),
    )
    await UserModel.create({mentraUserId: "mu_gone", tenantId: "mentra", tenantUserId: "gone", supportTelemetryDeletedAt: NOW})
    await removeInStore(ORG_ACME, U.acmeOwner)

    const dry = await withReadOnlyTarget(target => run({target}))
    const report = await run({apply: true})

    expect(report).toEqual({...dry, mode: "apply"})
    expect(report.keptLastOwners).toEqual([{orgId: ORG_ACME, membershipId: ownerId, userId: U.acmeOwner}])
    expect(report.removedMemberships).toEqual([])
    expect(await WorkspaceMembershipModel.findOne({membershipId: ownerId}).lean()).toMatchObject({status: "active"})
  })
})

// --- Argument parsing and the remote guard ---------------------------------

describe("parseArgs", () => {
  const LOCAL_SOURCE = "mongodb://127.0.0.1:27031/store"
  const LOCAL_TARGET = "mongodb://127.0.0.1:27031/core"
  const REMOTE = "mongodb://mongo.example.invalid:27017/core"
  const args = (...rest: string[]) => [
    "--source",
    LOCAL_SOURCE,
    "--target",
    LOCAL_TARGET,
    ...rest,
  ]

  test("parses a dry run and an apply", () => {
    expect(parseArgs(args())).toEqual({
      source: LOCAL_SOURCE,
      target: LOCAL_TARGET,
      apply: false,
      allowRemote: false,
    })
    expect(parseArgs(args("--apply"))).toMatchObject({apply: true, allowRemote: false})
    expect(
      parseArgs([`--source=${LOCAL_SOURCE}`, `--target=${LOCAL_TARGET}`]),
    ).toMatchObject({
      source: LOCAL_SOURCE,
      target: LOCAL_TARGET,
    })
  })

  test("refuses --apply with a remote target", () => {
    const err = thrownSync(() =>
      parseArgs(["--source", LOCAL_SOURCE, "--target", REMOTE, "--apply"]),
    )
    expect(err).toBeInstanceOf(UsageError)
    expect(err.message).toContain("--i-understand-remote")
  })

  test("refuses --apply with a remote source", () => {
    expect(() =>
      parseArgs(["--source", REMOTE, "--target", LOCAL_TARGET, "--apply"]),
    ).toThrow(UsageError)
  })

  test("--i-understand-remote lifts the refusal, and a dry run never needed it", () => {
    const remoteArgs = [
      "--source",
      REMOTE,
      "--target",
      REMOTE.replace("/core", "/other"),
    ]
    expect(parseArgs([...remoteArgs, "--apply", "--i-understand-remote"])).toMatchObject({
      apply: true,
      allowRemote: true,
    })
    expect(parseArgs(remoteArgs)).toMatchObject({apply: false})
  })

  test("only plain loopback mongodb:// URLs without credentials count as local", () => {
    for (const url of [
      "mongodb://127.0.0.1:27031/core",
      "mongodb://localhost/core",
      "mongodb://[::1]:27017/core",
      "mongodb://LOCALHOST:27017/core?directConnection=true",
    ]) {
      expect(isLocalMongoUrl(url)).toBe(true)
    }
    for (const url of [
      REMOTE,
      "mongodb+srv://cluster0.example.invalid/core",
      "mongodb://user:pass@127.0.0.1:27017/core",
      "mongodb://127.0.0.1:27017,mongo.example.invalid:27017/core",
      "mongodb://mongo.example.invalid:27017,127.0.0.1:27017/core",
      "mongodb://127.0.0.1.example.invalid:27017/core",
      "http://127.0.0.1:27017/core",
      "not a url",
      "",
      // The scheme is matched exactly, so an unusual spelling is never classified.
      "MONGODB://127.0.0.1:27017/core",
      "Mongodb://localhost/core",
      // Loopback must be the whole host: nothing may trail the host or its port.
      "mongodb://[::1]evil:27017/core",
      "mongodb://[::1]evil/core",
      "mongodb://[::2]:27017/core",
      "mongodb://[::1:27017/core",
      "mongodb://127.0.0.1:27017\\evil/core",
      "mongodb://127.0.0.1\\evil:27017/core",
      "mongodb://127.0.0.1:abc/core",
      "mongodb://127.0.0.1:/core",
      "mongodb://127.0.0.1:27017x/core",
      "mongodb://localhost.:27017/core",
      "mongodb://localhost.evil.invalid/core",
      "mongodb:// 127.0.0.1:27017/core",
      "mongodb://127.0.0.1:27017 /core",
    ]) {
      expect(isLocalMongoUrl(url)).toBe(false)
    }
  })

  test("--apply refuses hosts that only look like loopback, and an unusual scheme spelling is not a URL", () => {
    for (const evil of ["[::1]evil:27017", "127.0.0.1:27017\\evil", "127.0.0.1:abc", "localhost.:27017"]) {
      const err = thrownSync(() =>
        parseArgs([
          "--source",
          LOCAL_SOURCE,
          "--target",
          `mongodb://${evil}/core`,
          "--apply",
        ]),
      )
      expect(err).toBeInstanceOf(UsageError)
      expect(err.message).toContain("--i-understand-remote")
    }
    for (const flag of ["--source", "--target"]) {
      const urls = {"--source": LOCAL_SOURCE, "--target": LOCAL_TARGET, [flag]: "MONGODB://127.0.0.1:27031/other"}
      const err = thrownSync(() =>
        parseArgs([
          "--source",
          urls["--source"],
          "--target",
          urls["--target"],
          "--apply",
        ]),
      )
      expect(err).toBeInstanceOf(UsageError)
      expect(err.message).toContain(flag)
    }
  })

  test("rejects missing, repeated and unknown arguments", () => {
    expect(() => parseArgs([])).toThrow(UsageError)
    expect(() => parseArgs(["--source", LOCAL_SOURCE])).toThrow(/--target/)
    expect(() => parseArgs(["--target", LOCAL_TARGET])).toThrow(/--source/)
    expect(() => parseArgs(args("--bogus"))).toThrow(/--bogus/)
    expect(() => parseArgs(args("--source", LOCAL_SOURCE))).toThrow(/--source/)
    expect(() => parseArgs(["--source", "--target", LOCAL_TARGET])).toThrow(UsageError)
    expect(() =>
      parseArgs(["--source", "not a url", "--target", LOCAL_TARGET]),
    ).toThrow(UsageError)
  })

  test("refuses a source and target that are the same database", () => {
    expect(() =>
      parseArgs(["--source", LOCAL_TARGET, "--target", LOCAL_TARGET]),
    ).toThrow(/same database/)
  })

  test("refuses the same database under loopback aliases, a default port or reordered hosts", () => {
    for (const [sourceUrl, targetUrl] of [
      ["mongodb://localhost/store", "mongodb://127.0.0.1:27017/store"],
      ["mongodb://[::1]:27017/store", "mongodb://localhost:27017/store"],
      ["mongodb://a.example:27017,b.example:27017/store", "mongodb://B.example,a.example/store"],
    ]) {
      expect(() => parseArgs(["--source", sourceUrl!, "--target", targetUrl!])).toThrow(/same database/)
    }
    expect(() => parseArgs(["--source", "mongodb://127.0.0.1/store", "--target", "mongodb://localhost/core"])).not.toThrow()
  })
})

// --- The command line ------------------------------------------------------

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {...process.env, ...env},
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {stdout, stderr, exitCode}
}

describe("command line", () => {
  test("--apply with a remote target exits non-zero before connecting anywhere", async () => {
    // `.invalid` never resolves, so even a guard bug could not reach a real database.
    const result = await runCli([
      "--source",
      sourceUrl,
      "--target",
      "mongodb://mongo.example.invalid:27017/core",
      "--apply",
    ])

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("--i-understand-remote")
    expect((await targetCounts()).Workspace).toBe(0)
  }, 30_000)

  test("a dry run prints only the JSON report on stdout and writes nothing", async () => {
    const result = await runCli(["--source", sourceUrl, "--target", targetUrl])

    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    const expected = await withReadOnlyTarget(target =>
      migrateStoreDeveloperOrgs({source, target, apply: false}),
    )
    expect(report).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(report.targetCompared).toBe(true)
    expect(report.mode).toBe("dry-run")
    expect(report.counts).toEqual({orgs: 4, memberships: 7, invitations: 3, credentials: 4, skippedKeys: 3})
    expect(await targetCounts()).toEqual({
      Workspace: 0,
      WorkspaceMembership: 0,
      WorkspaceInvitation: 0,
      AccessCredential: 0,
      WorkspaceAuditEvent: 0,
    })
    // Progress goes to stderr; stdout is the report alone, and it never carries a hash.
    for (const key of SOURCE_KEYS) expect(result.stdout).not.toContain(key.hash)
    for (const hash of Object.values(tokenHashes)) expect(result.stdout).not.toContain(hash)
  }, 30_000)

  test("--apply on local databases imports, and a second run changes nothing", async () => {
    const cli = ["--source", sourceUrl, "--target", targetUrl, "--apply"]

    const first = await runCli(cli)
    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout).mode).toBe("apply")
    const afterFirst = await snapshotTarget()
    expect((await targetCounts()).Workspace).toBe(4)

    const second = await runCli(cli)
    expect(second.exitCode).toBe(0)
    expect(await snapshotTarget()).toEqual(afterFirst)
  }, 60_000)

  test("bad source data leaves a fresh target database without even its collections", async () => {
    const freshUrl = localTestMongoUrl("core-fresh")
    const fresh = await openSourceConnection(freshUrl)
    try {
      assertConnectedTo(freshUrl, fresh.name)
      const collections = async () => (await fresh.db!.listCollections().toArray()).map(entry => entry.name).sort()
      const cli = ["--source", sourceUrl, "--target", freshUrl]
      await sourceDb()
        .collection("developer_org_memberships")
        .insertOne({orgId: ORG_GAMMA, userId: U.stranger, role: "superuser", status: "active"})

      // The source is validated before the target is connected, so a failed apply creates nothing.
      const failed = await runCli([...cli, "--apply"])
      expect(failed.exitCode).not.toBe(0)
      expect(failed.stderr).toContain("superuser")
      expect(failed.stdout).toBe("")
      expect(await collections()).toEqual([])

      await sourceDb().collection("developer_org_memberships").deleteOne({role: "superuser"})
      // A dry run only reads the target, so it creates nothing there either.
      expect((await runCli(cli)).exitCode).toBe(0)
      expect(await collections()).toEqual([])

      const applied = await runCli([...cli, "--apply"])
      expect(applied.exitCode).toBe(0)
      expect(await collections()).toEqual(
        [
          "access_credentials",
          "workspace_audit_events",
          "workspace_invitations",
          "workspace_memberships",
          "workspaces",
        ].sort(),
      )
      // The indexes the import relies on were built by the apply, and none of them is a new unique one.
      const indexNames = (await fresh.db!.collection("workspace_memberships").indexes()).map(index => index.name)
      expect(indexNames).toContain("pendingWorkosUserId_1_status_1")
      expect(indexNames).not.toContain("workspaceId_1_pendingWorkosUserId_1")
    } finally {
      assertConnectedTo(freshUrl, fresh.name)
      await fresh.dropDatabase()
      await fresh.close()
    }
  }, 60_000)
})
