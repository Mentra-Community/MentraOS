/**
 * @fileoverview Admin API keys made before operator keys keep working as operator keys.
 *
 * Before operator keys, an incident admin key was a developer-organization API key
 * (`msk_<env>_<keyId>.<secret>`, a row of Core's own `developer_org_api_keys`)
 * whose address `api-key@<keyId>.local` was on `CLOUD_CORE_ADMIN_EMAILS`. These
 * tests seed such rows the way the earlier Core wrote them, run the startup
 * conversion, and drive the real Core app (`createApp`) at `/api/admin` with the
 * original tokens. People (an Organization Admin, a workspace owner) sign in
 * through a fake identity provider (`support/fake-idp.ts`) playing Supabase Auth
 * and GoTrue; credentials, audit events and reports are real rows on a local
 * replica set.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on that
 * database before any destructive call. The database is dropped in `afterAll`,
 * only if the check passed. Converting a key needs no transaction (a Private
 * Cloud database may not have them), but the rest of Core does, so the Mongo
 * must be a replica set.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/legacy-admin-keys.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {runStartupMigrations} from "../packages/core/src/migrations/startup.migrations"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {ReportModel} from "../packages/core/src/models/report.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {convertLegacyAdminKeys} from "../packages/core/src/services/workspaces/legacy-admin-keys"
import {deploymentEnvironmentLabel} from "../packages/core/src/services/workspaces/organization"
import {OPERATOR_KEY_SCOPES} from "../packages/workspace-contract/src/index"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {legacyAdminKey, legacyKeyAddress, legacyKeys} from "./support/legacy-admin-key"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  coreAccessToken,
  ADMIN_EMAIL,
  applyEnv,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

// Index builds on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  ReportModel,
  UserModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]
const OPERATOR_SCOPES = [...OPERATOR_KEY_SCOPES].sort()

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- Fixtures --------------------------------------------------------------

/**
 * A person with a confirmed Supabase account, reachable with the returned bearer: a Core access
 * token from Core's sign-in server.
 */
async function person(key: string, email = `${key}@example.test`): Promise<string> {
  const sub = `supa-${key}`
  idp.registerUser({sub, email, emailConfirmed: true})
  return coreAccessToken({sub, email, emailVerified: true})
}

/** A developer-organization API key row as the earlier Core wrote it, with its token. */
const legacyKey = legacyAdminKey
const address = legacyKeyAddress

function allowlist(...keys: Array<{keyId: string}>) {
  process.env.CLOUD_CORE_ADMIN_EMAILS = [ADMIN_EMAIL, ...keys.map(address)].join(",")
}

interface Reply {
  status: number
  json: any
}

async function call(method: string, path: string, bearer?: string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (bearer) headers.authorization = `Bearer ${bearer}`
  if (body !== undefined) headers["content-type"] = "application/json"
  const response = await app.request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, json}
}

async function seedReport(reportId = "rep_legacy_admin_1") {
  await ReportModel.create({reportId, mentraUserId: "mu_reporter", kind: "bug", status: "ready", context: {}})
  return reportId
}

const createdEvents = (credentialId: string) =>
  WorkspaceAuditEventModel.find({action: "credential.created", "target.credentialId": credentialId}).lean()

const noChanges = {converted: [], revoked: [], failed: []}

/**
 * Make the database refuse to store an access credential for `keyId` (a collection validator), as a
 * failing write would, until the returned function lifts it.
 */
async function refuseCredentialRows(keyId: string): Promise<() => Promise<void>> {
  const db = AccessCredentialModel.db.db!
  await db.command({
    collMod: "access_credentials",
    validator: {credentialId: {$ne: keyId}},
    validationLevel: "strict",
    validationAction: "error",
  })
  return async () => {
    await db.command({collMod: "access_credentials", validator: {}, validationLevel: "off"})
  }
}

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("legacy-admin-keys")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({
    ...HOSTED_ENV,
    CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
    CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
    CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
    CLOUD_CORE_ENVIRONMENT: undefined,
    CLOUD_CORE_WORKSPACE_CREATION: undefined,
    CONSOLE2_URL: undefined,
    MENTRA_ACCOUNT_JWT_PUBLIC_KEY: undefined,
  })
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  await legacyKeys().deleteMany({})
  resetIdpTokenCaches()
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

// --- Tests -----------------------------------------------------------------

describe("legacy admin keys", () => {
  test("an allowlisted key reads incidents with its original token after Core starts", async () => {
    const key = await legacyKey()
    allowlist(key)
    const reportId = await seedReport()

    await runStartupMigrations()

    const reports = await call("GET", "/api/admin/reports", key.token)
    expect(reports.status).toBe(200)
    expect(reports.json.reports.map((report: {reportId: string}) => report.reportId)).toEqual([reportId])
    expect((await call("GET", `/api/admin/reports/${reportId}`, key.token)).status).toBe(200)

    const me = await call("GET", "/api/admin/me", key.token)
    expect(me.status).toBe(200)
    expect(me.json.user).toBeNull()
    expect(me.json.credential).toEqual({credentialId: key.keyId, credentialKind: "organization", label: "Incident triage"})
    expect([...me.json.organization.capabilities].sort()).toEqual(OPERATOR_SCOPES)
    expect(me.json.workspaces).toEqual([])
  })

  test("the converted key is refused on the organization administration and workspace APIs, which are for people", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)

    for (const [method, path, body] of [
      ["GET", "/api/admin/organization/credentials"],
      ["POST", "/api/admin/organization/credentials", {name: "minted by a key", scopes: ["organization.incidents.read"]}],
      ["GET", "/api/admin/organization/workspaces"],
      ["POST", "/api/admin/organization/workspaces/ws_1/owners", {mentraUserId: "mu_1"}],
      ["GET", "/api/organization/credentials"],
      ["GET", "/api/organization/workspaces"],
      ["GET", "/api/admin/workspaces"],
      ["POST", "/api/admin/workspaces", {name: "Keyed"}],
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces", {name: "Keyed"}],
      // The audit log needs an Organization Admin who is a person.
      ["GET", "/api/admin/audit-log"],
    ] as Array<[string, string, unknown?]>) {
      const reply = await call(method, path, key.token, body)
      expect({method, path, status: reply.status, error: reply.json?.error}).toEqual({
        method,
        path,
        status: 403,
        error: "forbidden",
      })
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(1)
    expect(await WorkspaceModel.countDocuments({})).toBe(0)

    // It may still ask what it may do here.
    const organization = await call("GET", "/api/organization", key.token)
    expect(organization.status).toBe(200)
    expect([...organization.json.capabilities].sort()).toEqual(OPERATOR_SCOPES)
    expect(organization.json.workspaceCreation).toEqual({allowed: false, reason: "not_a_person"})
  })

  test("the operator key keeps the key's id, hash, environment, last 4 and msk prefix", async () => {
    const key = await legacyKey()
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [key.keyId], revoked: [], failed: []})

    const row = await AccessCredentialModel.findOne({credentialId: key.keyId}).lean()
    expect(row).toMatchObject({
      credentialId: key.keyId,
      prefix: "msk",
      credentialKind: "organization",
      workspaceId: null,
      name: "Incident triage",
      env: "local",
      hash: key.hash,
      last4: key.last4,
      packageNames: [],
      createdByEmail: address(key),
      createdByMembershipId: null,
      createdByMentraUserId: null,
      issuedByService: null,
      expiresAt: null,
      revokedAt: null,
    })
    expect([...row!.scopes].sort()).toEqual(OPERATOR_SCOPES)
    expect(row!.createdAt).toEqual(new Date("2026-06-01T00:00:00Z"))
    const events = await createdEvents(key.keyId)
    expect(events).toHaveLength(1)
    expect(events[0]!.actor).toMatchObject({kind: "system"})
    expect(events[0]!.workspaceId).toBeNull()
    expect(JSON.stringify(events)).not.toContain(key.hash)

    // An Organization Admin sees it among the operator keys, under the prefix it carries.
    const admin = await person("org-admin", ADMIN_EMAIL)
    const listed = await call("GET", "/api/organization/credentials", admin)
    expect(listed.status).toBe(200)
    expect(listed.json.items).toEqual([
      expect.objectContaining({credentialId: key.keyId, prefix: "msk", display: `msk_local_…${key.last4}`}),
    ])
    expect(JSON.stringify(listed.json)).not.toContain(key.hash)
  })

  test("the address on the allowlist is matched in any case", async () => {
    const key = await legacyKey()
    process.env.CLOUD_CORE_ADMIN_EMAILS = ` API-KEY@${key.keyId.toLowerCase()}.LOCAL , ${ADMIN_EMAIL}`

    expect((await convertLegacyAdminKeys()).converted).toEqual([key.keyId])

    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })

  test("removed from the allowlist the key is refused, and listed again it works again", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)

    process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
    expect((await call("GET", "/api/admin/me", key.token)).status).toBe(401)

    allowlist(key)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })

  test("the token is accepted only with the prefix its row records", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()

    const asOperatorPrefix = key.token.replace(/^msk_/, "mak_")
    expect((await call("GET", "/api/admin/reports", asOperatorPrefix)).status).toBe(401)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })

  test("a key that is not allowlisted is not converted and is refused", async () => {
    const listed = await legacyKey()
    const unlisted = await legacyKey()
    allowlist(listed)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [listed.keyId], revoked: [], failed: []})

    expect(await AccessCredentialModel.exists({credentialId: unlisted.keyId})).toBeNull()
    expect((await call("GET", "/api/admin/reports", unlisted.token)).status).toBe(401)
  })

  test("a workspace credential (msk_) that is not allowlisted is refused on organization routes", async () => {
    const owner = await person("ws-owner")
    const workspace = await call("POST", "/api/workspaces", owner, {name: "Acme"})
    expect(workspace.status).toBe(201)
    const credential = await call("POST", `/api/workspaces/${workspace.json.workspaceId}/credentials`, owner, {
      name: "ci",
    })
    expect(credential.status).toBe(201)
    const token: string = credential.json.token
    expect(token.startsWith("msk_")).toBe(true)
    await seedReport()

    await convertLegacyAdminKeys()

    expect((await call("GET", "/api/admin/reports", token)).status).toBe(403)
    const me = await call("GET", "/api/admin/me", token)
    expect(me.status).toBe(200)
    expect(me.json.organization.capabilities).toEqual([])
    expect(me.json.credential).toMatchObject({credentialKind: "workspace"})
    expect(await AccessCredentialModel.findOne({credentialId: credential.json.credential.credentialId}).lean()).toMatchObject({
      credentialKind: "workspace",
    })
  })

  test("an allowlisted id that is already a workspace credential stays one", async () => {
    const owner = await person("ws-owner")
    const workspace = await call("POST", "/api/workspaces", owner, {name: "Acme"})
    const credential = await call("POST", `/api/workspaces/${workspace.json.workspaceId}/credentials`, owner, {
      name: "ci",
    })
    const credentialId: string = credential.json.credential.credentialId
    process.env.CLOUD_CORE_ADMIN_EMAILS = `${ADMIN_EMAIL},api-key@${credentialId}.local`

    expect(await convertLegacyAdminKeys()).toEqual(noChanges)

    expect(await AccessCredentialModel.findOne({credentialId}).lean()).toMatchObject({credentialKind: "workspace"})
    expect((await call("GET", "/api/admin/reports", credential.json.token)).status).toBe(403)
  })

  test("a revoked key is never converted", async () => {
    const key = await legacyKey({revokedAt: new Date("2026-07-01T00:00:00Z")})
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual(noChanges)
    expect(await convertLegacyAdminKeys()).toEqual(noChanges)

    expect(await AccessCredentialModel.exists({credentialId: key.keyId})).toBeNull()
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
  })

  test("a key that could never validate is not converted", async () => {
    const key = await legacyKey()
    await legacyKeys().updateOne({keyId: key.keyId}, {$set: {hash: "not-a-hash"}})
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual(noChanges)
    expect(await AccessCredentialModel.exists({credentialId: key.keyId})).toBeNull()
  })

  test("the conversion is idempotent: a re-run changes nothing and records nothing", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    const before = await AccessCredentialModel.findOne({credentialId: key.keyId}).lean()

    expect(await convertLegacyAdminKeys()).toEqual(noChanges)
    await runStartupMigrations()

    const after = await AccessCredentialModel.findOne({credentialId: key.keyId}).lean()
    expect(after).toEqual(before)
    expect(await AccessCredentialModel.countDocuments({credentialId: key.keyId})).toBe(1)
    expect(await createdEvents(key.keyId)).toHaveLength(1)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })

  test("an operator key revoked in Core stays revoked when Core starts again", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    const admin = await person("org-admin", ADMIN_EMAIL)

    expect((await call("DELETE", `/api/organization/credentials/${key.keyId}`, admin)).status).toBe(204)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)

    expect(await convertLegacyAdminKeys()).toEqual(noChanges)
    expect((await AccessCredentialModel.findOne({credentialId: key.keyId}).lean())!.revokedAt).toBeInstanceOf(Date)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
  })

  test("a key revoked in the legacy collection after its conversion is revoked in Core too", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    await legacyKeys().updateOne({keyId: key.keyId}, {$set: {revokedAt: new Date("2026-08-01T00:00:00Z")}})

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: [key.keyId], failed: []})
    expect(await convertLegacyAdminKeys()).toEqual(noChanges)

    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
    const revocations = await WorkspaceAuditEventModel.find({
      action: "credential.revoked",
      "target.credentialId": key.keyId,
    }).lean()
    expect(revocations).toHaveLength(1)
    expect(revocations[0]!.actor).toMatchObject({kind: "system"})
  })

  test("a key keeps the environment label it was issued under", async () => {
    const key = await legacyKey({env: "prod"})
    allowlist(key)
    await convertLegacyAdminKeys()

    // This Core accepts only `local` labels until told otherwise, as for every credential.
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
    delete process.env.CLOUD_CORE_ENVIRONMENT
    process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "local,prod"
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })

  test("with no credential environments and no environment set, a key labelled from CONSOLE2_URL still validates after conversion", async () => {
    const consoles: Array<[string, string]> = [
      ["https://console2.dev.mentraglass.com", "dev"],
      ["https://console2.staging.mentraglass.com", "staging"],
      ["https://console2.mentraglass.com", "prod"],
    ]
    for (const [consoleUrl, label] of consoles) {
      process.env.CONSOLE2_URL = consoleUrl
      // The earlier Core's console labelled a new key with this deployment's environment.
      const created = await legacyKey({env: deploymentEnvironmentLabel(), orgId: "org_console"})
      expect(created.token.startsWith(`msk_${label}_`)).toBe(true)
      allowlist(created)

      expect({consoleUrl, result: await convertLegacyAdminKeys()}).toEqual({
        consoleUrl,
        result: {converted: [created.keyId], revoked: [], failed: []},
      })

      const reports = await call("GET", "/api/admin/reports", created.token)
      expect({consoleUrl, status: reports.status}).toEqual({consoleUrl, status: 200})
      expect((await AccessCredentialModel.findOne({credentialId: created.keyId}).lean())!.env).toBe(label)
      // Another deployment's label is not this one's.
      process.env.CONSOLE2_URL = "http://localhost:3000"
      expect({consoleUrl, status: (await call("GET", "/api/admin/reports", created.token)).status}).toEqual({
        consoleUrl,
        status: 401,
      })
    }
  })

  test("converting and carrying over a revocation never open a transaction", async () => {
    // Cosmos DB for MongoDB and a standalone mongod have no multi-document transactions.
    const startSession = spyOn(AccessCredentialModel.db, "startSession").mockImplementation(() => {
      throw new Error("Transaction numbers are only allowed on a replica set member or mongos")
    })
    try {
      const key = await legacyKey()
      allowlist(key)
      expect(await convertLegacyAdminKeys()).toEqual({converted: [key.keyId], revoked: [], failed: []})
      expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)

      await legacyKeys().updateOne({keyId: key.keyId}, {$set: {revokedAt: new Date("2026-08-01T00:00:00Z")}})
      expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: [key.keyId], failed: []})
      expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)

      expect(startSession).not.toHaveBeenCalled()
      expect(await createdEvents(key.keyId)).toHaveLength(1)
    } finally {
      startSession.mockRestore()
    }
  })

  test("a failed conversion is reported in failed, does not throw or stop the others, and the next start converts it", async () => {
    const failing = await legacyKey({name: "Refused"})
    const fine = await legacyKey({name: "Fine"})
    allowlist(failing, fine)
    const lift = await refuseCredentialRows(failing.keyId)
    try {
      expect(await convertLegacyAdminKeys()).toEqual({converted: [fine.keyId], revoked: [], failed: [failing.keyId]})
      // Core still starts.
      expect(await runStartupMigrations()).toBeUndefined()
    } finally {
      await lift()
    }

    // Nothing of the failed key was written, and it does not validate yet.
    expect(await AccessCredentialModel.exists({credentialId: failing.keyId})).toBeNull()
    expect(await createdEvents(failing.keyId)).toHaveLength(0)
    expect((await call("GET", "/api/admin/reports", failing.token)).status).toBe(401)
    expect((await call("GET", "/api/admin/reports", fine.token)).status).toBe(200)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [failing.keyId], revoked: [], failed: []})
    expect((await call("GET", "/api/admin/reports", failing.token)).status).toBe(200)
    expect(await createdEvents(failing.keyId)).toHaveLength(1)
  })
})
