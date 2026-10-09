/**
 * @fileoverview Admin API keys made before operator keys keep working as operator keys.
 *
 * Before operator keys, an incident admin key was a developer-organization API key
 * (`msk_<env>_<keyId>.<secret>`, a row of Core's own `developer_org_api_keys`)
 * whose address `api-key@<keyId>.local` was on `CLOUD_CORE_ADMIN_EMAILS`. These
 * tests seed such rows the way the earlier Core wrote them, run the startup
 * conversion, and drive the real Core app (`createApp`) at `/api/admin` with the
 * original tokens. WorkOS identity is stubbed (a bearer maps to a fixed identity),
 * as in `admin-capabilities.integration.test.ts`; credentials, audit events and
 * reports are real rows on a local replica set.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on that
 * database before any destructive call. The database is dropped in `afterAll`,
 * only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/legacy-admin-keys.integration.test.ts`
 */

import {createHash, randomBytes} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {runStartupMigrations} from "../packages/core/src/migrations/startup.migrations"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {ReportModel} from "../packages/core/src/models/report.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resolveWorkosUser} from "../packages/core/src/services/workspaces/identity-link.service"
import {convertLegacyAdminKeys} from "../packages/core/src/services/workspaces/legacy-admin-keys"
import * as developerAuth from "../packages/developer-auth/src/index"
import {OPERATOR_KEY_SCOPES} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

// Index builds on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  IdentityLinkModel,
  ReportModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]
const LEGACY_KEYS = "developer_org_api_keys"
/** The legacy collection, through the connection the models use (the only one this test opens). */
const legacyKeys = () => WorkspaceModel.db.collection(LEGACY_KEYS)
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A key id of the shape the earlier Core minted (a ULID). */
const keyIdOf = () => [...randomBytes(26)].map((byte, index) => CROCKFORD[index === 0 ? byte % 8 : byte % 32]).join("")

const ADMIN_EMAIL = "org-admin@example.test"
const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "MENTRA_ACCOUNT_JWT_PUBLIC_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>

// --- WorkOS stub -----------------------------------------------------------

const identities = new Map<string, {id: string; email: string}>()
let requestAuth: ReturnType<typeof spyOn>
let tokenAuth: ReturnType<typeof spyOn>

function authResult(value: string | undefined): developerAuth.DeveloperAuthResult {
  const identity = value ? identities.get(value) : undefined
  if (!identity) return {authenticated: false, reason: "invalid_token"}
  return {
    authenticated: true,
    user: {id: identity.id, email: identity.email, emailVerified: true, firstName: "Test", lastName: "User"},
    organizationId: null,
    accessToken: value!,
  }
}

/** A signed-in person with a linked Mentra user, reachable with `Bearer <bearer>`. */
async function person(key: string, email = `${key}@example.test`): Promise<string> {
  const bearer = `tok-${key}`
  identities.set(bearer, {id: `workos_${key}`, email})
  await resolveWorkosUser({workosUserId: `workos_${key}`, email, emailVerified: true, name: null})
  return bearer
}

// --- Fixtures --------------------------------------------------------------

interface LegacyKey {
  keyId: string
  token: string
  hash: string
  last4: string
}

/** A developer-organization API key row as the earlier Core wrote it, with its token. */
async function legacyKey(options: {env?: string; revokedAt?: Date | null; name?: string} = {}): Promise<LegacyKey> {
  const env = options.env ?? "local"
  const keyId = keyIdOf()
  const secret = randomBytes(32).toString("base64url")
  const hash = createHash("sha256").update(secret).digest("hex")
  await legacyKeys().insertOne({
    keyId,
    orgId: "org_legacy",
    name: options.name ?? "Incident triage",
    env,
    hash,
    last4: secret.slice(-4),
    createdByUserId: "user_legacy",
    lastUsedAt: null,
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  })
  return {keyId, token: `msk_${env}_${keyId}.${secret}`, hash, last4: secret.slice(-4)}
}

const address = (key: LegacyKey) => `api-key@${key.keyId}.local`

function allowlist(...keys: LegacyKey[]) {
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

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("legacy-admin-keys")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))

  requestAuth = spyOn(developerAuth, "authenticateWorkosRequest").mockImplementation((async (c: any) => {
    const header = c.req.header("authorization")
    return authResult(header?.startsWith("Bearer ") ? header.slice(7) : undefined)
  }) as any)
  tokenAuth = spyOn(developerAuth, "authenticateWorkosAccessToken").mockImplementation((async (token: string) =>
    authResult(token)) as any)
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  requestAuth?.mockRestore()
  tokenAuth?.mockRestore()
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  await legacyKeys().deleteMany({})
  identities.clear()
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
  delete process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.WORKOS_API_KEY = "test-workos-api-key"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
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
    expect(me.json.credential).toEqual({credentialId: key.keyId, label: "Incident triage"})
    expect(me.json.organization.capabilities).toEqual([...OPERATOR_KEY_SCOPES].sort())
  })

  test("the operator key keeps the key's id, hash, environment, last 4 and msk prefix", async () => {
    const key = await legacyKey()
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [key.keyId], revoked: []})

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
      issuedByService: null,
      expiresAt: null,
      revokedAt: null,
    })
    expect([...row!.scopes].sort()).toEqual([...OPERATOR_KEY_SCOPES].sort())
    expect(row!.createdAt).toEqual(new Date("2026-06-01T00:00:00Z"))
    const events = await createdEvents(key.keyId)
    expect(events).toHaveLength(1)
    expect(events[0]!.actor).toMatchObject({kind: "system"})
    expect(JSON.stringify(events)).not.toContain(key.hash)

    // An Organization Admin sees it among the operator keys, under the prefix it carries.
    const admin = await person("org-admin", ADMIN_EMAIL)
    const listed = await call("GET", "/api/organization/credentials", admin)
    expect(listed.status).toBe(200)
    expect(listed.json.items).toEqual([
      expect.objectContaining({credentialId: key.keyId, prefix: "msk", display: `msk_local_…${key.last4}`}),
    ])
  })

  test("the address on the allowlist is matched in any case", async () => {
    const key = await legacyKey()
    process.env.CLOUD_CORE_ADMIN_EMAILS = ` API-KEY@${key.keyId.toLowerCase()}.LOCAL , ${ADMIN_EMAIL}`

    await convertLegacyAdminKeys()

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

    expect(await convertLegacyAdminKeys()).toEqual({converted: [listed.keyId], revoked: []})

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

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})

    expect(await AccessCredentialModel.findOne({credentialId}).lean()).toMatchObject({credentialKind: "workspace"})
    expect((await call("GET", "/api/admin/reports", credential.json.token)).status).toBe(403)
  })

  test("a revoked key is never converted", async () => {
    const key = await legacyKey({revokedAt: new Date("2026-07-01T00:00:00Z")})
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})
    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})

    expect(await AccessCredentialModel.exists({credentialId: key.keyId})).toBeNull()
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
  })

  test("a key that could never validate is not converted", async () => {
    const key = await legacyKey()
    await legacyKeys().updateOne({keyId: key.keyId}, {$set: {hash: "not-a-hash"}})
    allowlist(key)

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})
    expect(await AccessCredentialModel.exists({credentialId: key.keyId})).toBeNull()
  })

  test("the conversion is idempotent: a re-run changes nothing and records nothing", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    const before = await AccessCredentialModel.findOne({credentialId: key.keyId}).lean()

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})
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

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})
    expect((await AccessCredentialModel.findOne({credentialId: key.keyId}).lean())!.revokedAt).toBeInstanceOf(Date)
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
  })

  test("a key revoked in the legacy collection after its conversion is revoked in Core too", async () => {
    const key = await legacyKey()
    allowlist(key)
    await convertLegacyAdminKeys()
    await legacyKeys().updateOne({keyId: key.keyId}, {$set: {revokedAt: new Date("2026-08-01T00:00:00Z")}})

    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: [key.keyId]})
    expect(await convertLegacyAdminKeys()).toEqual({converted: [], revoked: []})

    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
    expect(
      await WorkspaceAuditEventModel.countDocuments({action: "credential.revoked", "target.credentialId": key.keyId}),
    ).toBe(1)
  })

  test("a key keeps the environment label it was issued under", async () => {
    const key = await legacyKey({env: "prod"})
    allowlist(key)
    await convertLegacyAdminKeys()

    // This Core accepts only `local` labels until told otherwise, as for every credential.
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(401)
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    expect((await call("GET", "/api/admin/reports", key.token)).status).toBe(200)
  })
})
