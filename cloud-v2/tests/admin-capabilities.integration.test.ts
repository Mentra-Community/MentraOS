/**
 * @fileoverview Capability-gated admin API integration tests.
 *
 * These drive the real Core app (`createApp`) at `/api/admin`, with the real
 * principal middleware, services, models and transactions against a local
 * replica set. Two boundaries are faked:
 *  - WorkOS identity: a bearer value maps to a fixed WorkOS identity (the same
 *    stub `workspaces-api.integration.test.ts` uses). Memberships, identity
 *    links and credentials (`msk_` workspace keys, `mak_` operator keys) are
 *    real rows made through the public APIs.
 *  - The account directory (GoTrue): a loopback server that knows no accounts,
 *    so a first sign-in links to a `workos` tenant user and a support-profile
 *    lookup is a miss.
 *
 * What it pins: `/me` answers any principal (401 only without one); every
 * other admin route needs the organization capability its area is gated by; an
 * operator key carries only the scopes it was created with; a workspace key and
 * a person who is not an Organization Admin have none.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/admin-capabilities.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {ReportAssetModel} from "../packages/core/src/models/report-asset.model"
import {ReportModel} from "../packages/core/src/models/report.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {RoutineDispatchService} from "../packages/core/src/services/routine-dispatch.service"
import {resolveWorkosUser} from "../packages/core/src/services/workspaces/identity-link.service"
import * as developerAuth from "../packages/developer-auth/src/index"
import {capabilitiesForRole, ORGANIZATION_CAPABILITIES} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [
  AccessCredentialModel,
  AdminActionAuditLogModel,
  IdentityLinkModel,
  ReportAssetModel,
  ReportModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const ADMIN_EMAIL = "org-admin@example.test"
const INVITE_PREFIX = "https://core.example.test/invite/"
const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_WORKSPACE_CREATION",
  "CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE",
  "RESEND_API_KEY",
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

interface Identity {
  id: string
  email: string
  emailVerified: boolean
}

/** WorkOS access token -> the identity it stands for. */
const identities = new Map<string, Identity>()
let requestAuth: ReturnType<typeof spyOn>
let tokenAuth: ReturnType<typeof spyOn>

function authResult(value: string | undefined): developerAuth.DeveloperAuthResult {
  const identity = value ? identities.get(value) : undefined
  if (!identity) return {authenticated: false, reason: "invalid_token"}
  return {
    authenticated: true,
    user: {
      id: identity.id,
      email: identity.email,
      emailVerified: identity.emailVerified,
      firstName: "Test",
      lastName: "User",
    },
    organizationId: null,
    accessToken: value!,
  }
}

// --- Account directory stub ------------------------------------------------

// Knows no accounts: a first sign-in links to a `workos` tenant user and a support-profile lookup misses.
const directory = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== "/auth/v1/admin/users") return new Response(null, {status: 404})
    return Response.json({users: []})
  },
})

// --- Fixtures --------------------------------------------------------------

interface Person {
  bearer: string
  workosUserId: string
  email: string
  mentraUserId: string
}

/** A signed-in WorkOS person with a linked Mentra user, reachable with `Bearer <person.bearer>`. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const workosUserId = `workos_${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  const bearer = `tok-${key}`
  identities.set(bearer, {id: workosUserId, email, emailVerified})
  const {mentraUserId} = await resolveWorkosUser({workosUserId, email, emailVerified, name: null})
  return {bearer, workosUserId, email, mentraUserId}
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

/** One request through the real app. `as` is a person or a raw bearer token. */
async function call(
  method: string,
  path: string,
  opts: {as?: Person | string; body?: unknown; headers?: Record<string, string>} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {...opts.headers}
  if (opts.as) headers.authorization = `Bearer ${typeof opts.as === "string" ? opts.as : opts.as.bearer}`
  let body: string | undefined
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers["content-type"] = "application/json"
  }
  const response = await app.request(`http://localhost${path}`, {method, headers, body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, text, json}
}

/** An operator key (`mak_`) created through the API by an Organization Admin. */
async function operatorKey(name: string, scopes: string[]): Promise<{token: string; credentialId: string}> {
  const admin = await person(`creator-${name}`, {email: ADMIN_EMAIL})
  const created = await call("POST", "/api/organization/credentials", {as: admin, body: {name, scopes}})
  expect(created.status).toBe(201)
  return {token: created.json.token, credentialId: created.json.credential.credentialId}
}

/** A workspace with one owner, and a workspace key (`msk_`) the owner created for it. */
async function workspaceWithKey() {
  const owner = await person("ws-owner")
  const workspace = await call("POST", "/api/workspaces", {as: owner, body: {name: "Acme"}})
  expect(workspace.status).toBe(201)
  const workspaceId: string = workspace.json.workspaceId
  const credential = await call("POST", `/api/workspaces/${workspaceId}/credentials`, {
    as: owner,
    body: {name: "ci", packageNames: ["com.acme.app"]},
  })
  expect(credential.status).toBe(201)
  return {
    owner,
    workspaceId,
    token: credential.json.token as string,
    credentialId: credential.json.credential.credentialId as string,
  }
}

async function seedReport(reportId = "rep_capabilities_1") {
  await ReportModel.create({reportId, mentraUserId: "mu_reporter", kind: "bug", status: "ready", context: {}})
  return reportId
}

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("admin-capabilities")
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
  directory.stop(true)
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  identities.clear()
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
  delete process.env.CLOUD_CORE_WORKSPACE_CREATION
  delete process.env.RESEND_API_KEY
  process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = `${INVITE_PREFIX}{token}`
  process.env.SUPABASE_URL = directory.url.origin
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-directory-test-key"
  process.env.WORKOS_API_KEY = "test-workos-service-secret"
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

// --- /me -------------------------------------------------------------------

describe("GET /api/admin/me", () => {
  test("is 401 without a principal and the health check stays open", async () => {
    expect((await call("GET", "/api/admin/me")).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {as: "tok-unknown"})).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {as: "mak_local_notakey"})).status).toBe(401)
    const health = await call("GET", "/api/admin/health")
    expect(health.status).toBe(200)
    expect(health.json).toEqual({status: "ok", service: "cloud-core-admin"})
  })

  test("an Organization Admin sees every capability, in a stable order", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await call("GET", "/api/admin/me", {as: admin})

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      authenticated: true,
      user: {mentraUserId: admin.mentraUserId, email: ADMIN_EMAIL},
      credential: null,
      organization: {capabilities: [...ORGANIZATION_CAPABILITIES].sort()},
      workspaces: [],
    })
  })

  test("a person with no organization capability is let in, with their workspaces", async () => {
    const owner = await person("ws-owner")
    const created = await call("POST", "/api/workspaces", {as: owner, body: {name: "Acme"}})
    expect(created.status).toBe(201)

    const reply = await call("GET", "/api/admin/me", {as: owner})

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({
      authenticated: true,
      user: {mentraUserId: owner.mentraUserId, email: owner.email},
      credential: null,
      organization: {capabilities: []},
    })
    expect(reply.json.workspaces).toHaveLength(1)
    expect(reply.json.workspaces[0]).toMatchObject({
      workspaceId: created.json.workspaceId,
      name: "Acme",
      membership: {role: "owner"},
    })
    expect(new Set(reply.json.workspaces[0].capabilities)).toEqual(new Set(capabilitiesForRole("owner")))
  })

  test("an allowlisted address WorkOS has not verified is not an Organization Admin", async () => {
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    const reply = await call("GET", "/api/admin/me", {as: claimed})

    expect(reply.status).toBe(200)
    expect(reply.json.organization.capabilities).toEqual([])
    expect((await call("GET", "/api/admin/reports", {as: claimed})).status).toBe(403)
  })

  test("an operator key sees its credential and only the scopes it was created with, and no workspaces", async () => {
    const key = await operatorKey("ops", ["organization.testing.read", "organization.incidents.read"])

    const reply = await call("GET", "/api/admin/me", {as: key.token})

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      authenticated: true,
      user: null,
      credential: {credentialId: key.credentialId, label: "ops"},
      organization: {
        capabilities: ["organization.incidents.read", "organization.testing.read"],
      },
      workspaces: [],
    })
    expect(reply.text).not.toContain(key.token)
  })

  test("a workspace key is a principal with no organization capabilities and no workspaces", async () => {
    const ws = await workspaceWithKey()

    const reply = await call("GET", "/api/admin/me", {as: ws.token})

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      authenticated: true,
      user: null,
      credential: {credentialId: ws.credentialId, label: "ci"},
      organization: {capabilities: []},
      workspaces: [],
    })
    expect(reply.text).not.toContain(ws.token)
  })
})

// --- Incidents -------------------------------------------------------------

describe("incident reports", () => {
  test("an operator key with organization.incidents.read reads them", async () => {
    const reportId = await seedReport()
    const key = await operatorKey("incidents", ["organization.incidents.read"])

    const list = await call("GET", "/api/admin/reports", {as: key.token})
    expect(list.status).toBe(200)
    expect(list.json.reports.map((row: any) => row.reportId)).toEqual([reportId])

    const detail = await call("GET", `/api/admin/reports/${reportId}`, {as: key.token})
    expect(detail.status).toBe(200)
    expect(detail.json.report.reportId).toBe(reportId)

    expect((await call("GET", "/api/admin/reports/rep_nope", {as: key.token})).status).toBe(404)
  })

  test("the same key cannot write test dispatches or read anything outside its scope", async () => {
    const key = await operatorKey("incidents", ["organization.incidents.read"])

    const dispatch = await call("POST", "/api/admin/test-dispatches", {as: key.token, body: {}})
    expect(dispatch.status).toBe(403)
    expect(dispatch.json).toEqual({error: "forbidden"})

    for (const path of [
      "/api/admin/test-routines",
      "/api/admin/test-runs",
      "/api/admin/routine-catalog",
      "/api/admin/support-profiles/lookup?email=a%40example.test",
    ]) {
      expect([path, (await call("GET", path, {as: key.token})).status]).toEqual([path, 403])
    }
  })

  test("a workspace key is refused, even though it is a valid credential", async () => {
    await seedReport()
    const ws = await workspaceWithKey()

    const reply = await call("GET", "/api/admin/reports", {as: ws.token})

    expect(reply.status).toBe(403)
    expect(reply.json).toEqual({error: "forbidden"})
  })

  test("a person who is not an Organization Admin is refused, a workspace owner included", async () => {
    await seedReport()
    const owner = await person("ws-owner")
    await call("POST", "/api/workspaces", {as: owner, body: {name: "Acme"}})

    expect((await call("GET", "/api/admin/me", {as: owner})).status).toBe(200)
    expect((await call("GET", "/api/admin/reports", {as: owner})).status).toBe(403)
    expect((await call("GET", "/api/admin/test-routines", {as: owner})).status).toBe(403)
  })

  test("an Organization Admin reads them, and a request with no principal is 401", async () => {
    const reportId = await seedReport()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const list = await call("GET", "/api/admin/reports", {as: admin})
    expect(list.status).toBe(200)
    expect(list.json.reports.map((row: any) => row.reportId)).toEqual([reportId])
    expect((await call("GET", "/api/admin/reports")).status).toBe(401)
  })

  test("an operator key stops working when its creator leaves the admin allowlist", async () => {
    await seedReport()
    const key = await operatorKey("incidents", ["organization.incidents.read"])
    expect((await call("GET", "/api/admin/reports", {as: key.token})).status).toBe(200)

    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.test"

    expect((await call("GET", "/api/admin/reports", {as: key.token})).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {as: key.token})).status).toBe(401)
  })
})

// --- Testing ---------------------------------------------------------------

describe("testing routes", () => {
  // The routine catalog reads the routine source from GitHub; these tests are about the gate, not the source.
  let catalog: ReturnType<typeof spyOn>
  beforeEach(() => {
    catalog = spyOn(RoutineDispatchService.prototype, "catalog").mockResolvedValue({
      routineRevision: "a".repeat(40),
      routines: [],
    })
  })
  afterEach(() => catalog.mockRestore())

  test("reading needs organization.testing.read and writing needs organization.testing.manage", async () => {
    const reader = await operatorKey("reader", ["organization.testing.read"])
    const manager = await operatorKey("manager", ["organization.testing.manage"])

    // A read: allowed for the reader (no routine is enrolled here), refused for a key that can only manage.
    const routines = await call("GET", "/api/admin/test-routines", {as: reader.token})
    expect(routines.status).toBe(200)
    expect(routines.json.routines).toEqual([])
    expect((await call("GET", "/api/admin/test-routines", {as: manager.token})).status).toBe(403)

    // A write: refused for the reader; for the manager it passes the gate and fails on the body.
    const refused = await call("POST", "/api/admin/test-dispatches", {as: reader.token, body: {}})
    expect(refused.status).toBe(403)
    const invalid = await call("POST", "/api/admin/test-dispatches", {as: manager.token, body: {}})
    expect(invalid.status).toBe(400)
    expect(invalid.json.error).toBe("invalid_submission")
  })

  test("picker dispatches, reruns and routine preferences need organization.testing.manage", async () => {
    const reader = await operatorKey("reader", ["organization.testing.read"])
    const manager = await operatorKey("manager", ["organization.testing.manage"])
    const writes: Array<[method: string, path: string]> = [
      ["POST", "/api/admin/test-dispatches/picker"],
      ["POST", "/api/admin/test-runs/reruns/preview"],
      ["POST", "/api/admin/test-runs/reruns/individual"],
      ["POST", "/api/admin/test-runs/reruns/submit"],
      ["PATCH", "/api/admin/routines/routine-1/platforms/android/preferences"],
    ]

    for (const [method, path] of writes) {
      expect([path, (await call(method, path, {as: reader.token, body: {}})).status]).toEqual([path, 403])
      // Past the gate, a body that is not JSON is the first thing the route objects to.
      const passed = await call(method, path, {as: manager.token, headers: {"content-type": "text/plain"}})
      expect([path, passed.status]).toEqual([path, 400])
    }
  })

  test("an Organization Admin reads and writes, and is named by their email", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect((await call("GET", "/api/admin/test-routines", {as: admin})).status).toBe(200)
    expect((await call("POST", "/api/admin/test-dispatches", {as: admin, body: {}})).status).toBe(400)
  })
})

// --- Support profiles ------------------------------------------------------

describe("support profiles", () => {
  test("lookup needs organization.supportProfiles.read and the audit row names the caller", async () => {
    const key = await operatorKey("support", ["organization.supportProfiles.read"])
    const incidentsOnly = await operatorKey("incidents", ["organization.incidents.read"])
    const lookup = "/api/admin/support-profiles/lookup?email=nobody%40example.test"

    expect((await call("GET", lookup, {as: incidentsOnly.token})).status).toBe(403)
    expect(await AdminActionAuditLogModel.countDocuments({})).toBe(0)

    const reply = await call("GET", lookup, {as: key.token})
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({user: null, profile: null, devices: [], recentReports: []})
    const audit = await AdminActionAuditLogModel.find({}).lean()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({adminId: `credential:${key.credentialId}`, action: "support_profile.read"})
    // The queried address never lands in the durable audit row.
    expect(JSON.stringify(audit[0])).not.toContain("nobody@example.test")

    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    expect((await call("GET", lookup, {as: admin})).status).toBe(200)
    expect(await AdminActionAuditLogModel.countDocuments({adminId: ADMIN_EMAIL})).toBe(1)
  })
})
