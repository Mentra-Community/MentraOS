/**
 * @fileoverview Capability-gated admin API integration tests.
 *
 * These drive the real Core app (`createApp`) at `/api/admin`, with the real
 * principal middleware, services, models and transactions against a local
 * replica set. One boundary is faked: the identity provider. A fake Supabase
 * project (`support/fake-idp.ts`) signs the access tokens people present as
 * bearers and answers Core's per-person account lookups; it lists no accounts
 * by email, so a support-profile lookup is a miss. People reach the admin API
 * with an admin portal session cookie (as the admin portal does) or a bearer;
 * workspace keys (`msk_`) and operator keys (`mak_`) are real rows made through
 * the public APIs.
 *
 * What it pins: `/me` answers any principal (401 only without one); every
 * other admin route needs the organization capability its area is gated by; an
 * operator key carries only the scopes it was created with; a workspace key and
 * a person who is not an Organization Admin have none. The audit log
 * (`/audit-log`) and the organization API under `/api/admin/organization` need
 * an Organization Admin who is a person, and refuse every key. Core's former
 * built-in Store administration (`/submissions`, `/preinstalled/*`) is gone.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/admin-capabilities.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {ReportAssetModel} from "../packages/core/src/models/report-asset.model"
import {ReportModel} from "../packages/core/src/models/report.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {RoutineDispatchService} from "../packages/core/src/services/routine-dispatch.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {
  capabilitiesForRole,
  OPERATOR_KEY_SCOPES,
  ORGANIZATION_CAPABILITIES,
} from "../packages/workspace-contract/src/index"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  coreAccessToken,
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  AdminActionAuditLogModel,
  BrowserSessionModel,
  ReportAssetModel,
  ReportModel,
  UserModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as const

/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENVIRONMENT: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: "https://core.example.test/invite/{token}",
  RESEND_API_KEY: undefined,
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- Fixtures --------------------------------------------------------------

interface Person {
  sub: string
  email: string
  mentraUserId: string
  /** An access token from the fake Supabase project, for `Authorization: Bearer`. */
  bearer: string
  /** The person's admin portal session, as a `Cookie` header value. */
  cookie: string
}

/**
 * A person with a Mentra account at the fake identity provider, a Core user and an admin portal
 * session. Their email is verified unless `emailVerified` is false (on the account and the session).
 */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  idp.registerUser({sub, email, emailConfirmed: emailVerified})
  const bearer = await coreAccessToken({sub, email, emailVerified})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  const {cookieValue} = await createPortalSession("admin", {
    mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: sub,
    email,
    emailVerified,
    authTime: new Date(),
  })
  return {sub, email, mentraUserId, bearer, cookie: `${ADMIN_COOKIE}=${cookieValue}`}
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

/**
 * One request through the real app. `as` is a person or a raw bearer token. A person is sent with their
 * admin portal session cookie (from the admin portal's origin on unsafe requests), or with their bearer
 * when `via` is "bearer".
 */
async function call(
  method: string,
  path: string,
  opts: {as?: Person | string; via?: "session" | "bearer"; body?: unknown; headers?: Record<string, string>} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {...opts.headers}
  const as = opts.as
  if (typeof as === "string") headers.authorization = `Bearer ${as}`
  else if (as && opts.via === "bearer") headers.authorization = `Bearer ${as.bearer}`
  else if (as) {
    headers.cookie = as.cookie
    if (method !== "GET" && method !== "HEAD") headers.origin ??= ADMIN_ORIGIN
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers["content-type"] ??= "application/json"
  }
  const response = await app.request(`${ADMIN_ORIGIN}${path}`, {method, headers, body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, text, json}
}

/** An operator key (`mak_`) created through the admin portal by an Organization Admin. */
async function operatorKey(name: string, scopes: readonly string[]): Promise<{token: string; credentialId: string}> {
  const admin = await person(`creator-${name}`, {email: ADMIN_EMAIL})
  const created = await call("POST", "/api/admin/organization/credentials", {as: admin, body: {name, scopes}})
  expect(created.status).toBe(201)
  return {token: created.json.token, credentialId: created.json.credential.credentialId}
}

/** A workspace with one owner, and a workspace key (`msk_`) the owner created for it. */
async function workspaceWithKey() {
  const owner = await person("ws-owner")
  const workspace = await call("POST", "/api/workspaces", {as: owner, via: "bearer", body: {name: "Acme"}})
  expect(workspace.status).toBe(201)
  const workspaceId: string = workspace.json.workspaceId
  const credential = await call("POST", `/api/workspaces/${workspaceId}/credentials`, {
    as: owner,
    via: "bearer",
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
  // Startup migrations do not run here; the transactions need their collections and indexes.
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
  restoreEnv = applyEnv(TEST_ENV)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
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

// --- /me -------------------------------------------------------------------

describe("GET /api/admin/me", () => {
  test("is 401 without a principal and the health check stays open", async () => {
    expect((await call("GET", "/api/admin/me")).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {as: "not-a-token"})).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {as: "mak_local_notakey"})).status).toBe(401)
    expect((await call("GET", "/api/admin/me", {headers: {cookie: `${ADMIN_COOKIE}=not-a-session`}})).status).toBe(401)
    const health = await call("GET", "/api/admin/health")
    expect(health.status).toBe(200)
    expect(health.json).toEqual({status: "ok", service: "cloud-core-admin"})
  })

  test("an Organization Admin sees every capability, in the contract's order, by session or bearer", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const expected = {
      authenticated: true,
      user: {mentraUserId: admin.mentraUserId, email: ADMIN_EMAIL, emailVerified: true, isOrganizationAdmin: true},
      credential: null,
      organization: {capabilities: [...ORGANIZATION_CAPABILITIES]},
      workspaces: [],
      // This suite sets no Fleet URL.
      fleet: {installed: false},
    }

    const bySession = await call("GET", "/api/admin/me", {as: admin})
    expect(bySession.status).toBe(200)
    expect(bySession.json).toEqual(expected)
    const byBearer = await call("GET", "/api/admin/me", {as: admin, via: "bearer"})
    expect(byBearer.status).toBe(200)
    expect(byBearer.json).toEqual(expected)
  })

  test("a person with no organization capability is let in, with their workspaces", async () => {
    const owner = await person("ws-owner")
    const created = await call("POST", "/api/admin/workspaces", {as: owner, body: {name: "Acme"}})
    expect(created.status).toBe(201)

    const reply = await call("GET", "/api/admin/me", {as: owner})

    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({
      authenticated: true,
      user: {mentraUserId: owner.mentraUserId, email: owner.email, emailVerified: true, isOrganizationAdmin: false},
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

  test("an allowlisted address the identity provider has not verified is not an Organization Admin", async () => {
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    for (const via of ["session", "bearer"] as const) {
      const reply = await call("GET", "/api/admin/me", {as: claimed, via})
      expect(reply.status).toBe(200)
      expect(reply.json.user).toMatchObject({email: ADMIN_EMAIL, emailVerified: false, isOrganizationAdmin: false})
      expect(reply.json.organization.capabilities).toEqual([])
      expect((await call("GET", "/api/admin/reports", {as: claimed, via})).status).toBe(403)
    }
  })

  test("an operator key sees its credential and only the scopes it was created with, and no workspaces", async () => {
    const key = await operatorKey("ops", ["organization.testing.read", "organization.incidents.read"])

    const reply = await call("GET", "/api/admin/me", {as: key.token})

    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({
      authenticated: true,
      user: null,
      credential: {credentialId: key.credentialId, credentialKind: "organization", label: "ops"},
      organization: {
        capabilities: ["organization.incidents.read", "organization.testing.read"],
      },
      workspaces: [],
      // This suite sets no Fleet URL.
      fleet: {installed: false},
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
      credential: {credentialId: ws.credentialId, credentialKind: "workspace", label: "ci"},
      organization: {capabilities: []},
      workspaces: [],
      // This suite sets no Fleet URL.
      fleet: {installed: false},
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
    expect(dispatch.json.error).toBe("forbidden")

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
    expect(reply.json.error).toBe("forbidden")
  })

  test("a person who is not an Organization Admin is refused, a workspace owner included", async () => {
    await seedReport()
    const owner = await person("ws-owner")
    await call("POST", "/api/admin/workspaces", {as: owner, body: {name: "Acme"}})

    expect((await call("GET", "/api/admin/me", {as: owner})).status).toBe(200)
    for (const via of ["session", "bearer"] as const) {
      expect((await call("GET", "/api/admin/reports", {as: owner, via})).status).toBe(403)
      expect((await call("GET", "/api/admin/test-routines", {as: owner, via})).status).toBe(403)
      expect((await call("GET", "/api/admin/support-profiles/lookup?email=a%40example.test", {as: owner, via})).status).toBe(
        403,
      )
    }
  })

  test("an Organization Admin reads them, and a request with no principal is 401", async () => {
    const reportId = await seedReport()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const list = await call("GET", "/api/admin/reports", {as: admin})
    expect(list.status).toBe(200)
    expect(list.json.reports.map((row: any) => row.reportId)).toEqual([reportId])
    expect((await call("GET", "/api/admin/reports", {as: admin, via: "bearer"})).status).toBe(200)
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

  test("the split is by method, so a method no route serves is still a write", async () => {
    const reader = await operatorKey("reader", ["organization.testing.read"])
    const manager = await operatorKey("manager", ["organization.testing.manage"])

    for (const path of ["/api/admin/test-runs/run_1", "/api/admin/routine-catalog/routine-1", "/api/admin/test-builds"]) {
      expect([path, (await call("DELETE", path, {as: reader.token})).status]).toEqual([path, 403])
      // Past the gate there is nothing to delete.
      expect([path, (await call("DELETE", path, {as: manager.token})).status]).toEqual([path, 404])
    }
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

  test("an Organization Admin reads and writes, by session or bearer", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const via of ["session", "bearer"] as const) {
      expect((await call("GET", "/api/admin/test-routines", {as: admin, via})).status).toBe(200)
      expect((await call("POST", "/api/admin/test-dispatches", {as: admin, via, body: {}})).status).toBe(400)
    }
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

// --- The audit log ---------------------------------------------------------

describe("the audit log", () => {
  const AUDIT_LOG = "/api/admin/audit-log"

  test("an Organization Admin who is a person reads it, by session or bearer", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    await AdminActionAuditLogModel.create({
      adminId: ADMIN_EMAIL,
      action: "support_profile.read",
      targetType: "user_support_profile",
      targetId: "email_lookup_miss",
    })

    for (const via of ["session", "bearer"] as const) {
      const reply = await call("GET", AUDIT_LOG, {as: admin, via})
      expect([via, reply.status]).toEqual([via, 200])
      expect(reply.json.events).toMatchObject([{adminId: ADMIN_EMAIL, action: "support_profile.read"}])
    }
  })

  test("every key is refused, an operator key with every scope included, and so is anyone else", async () => {
    const operator = await operatorKey("all-scopes", OPERATOR_KEY_SCOPES)
    const ws = await workspaceWithKey()
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    for (const [label, caller] of [
      ["operator key", operator.token],
      ["workspace key", ws.token],
      ["workspace owner", ws.owner],
      ["unverified allowlisted address", claimed],
    ] as const) {
      const reply = await call("GET", AUDIT_LOG, {as: caller})
      expect([label, reply.status]).toEqual([label, 403])
      expect(reply.json.error).toBe("forbidden")
    }
    expect((await call("GET", AUDIT_LOG)).status).toBe(401)
  })

  test("the former built-in Store's administration is gone, even for an Organization Admin", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    for (const [method, path] of [
      ["GET", "/api/admin/submissions"],
      ["POST", "/api/admin/submissions/rel_1/approve"],
      ["POST", "/api/admin/submissions/rel_1/publish"],
      ["GET", "/api/admin/preinstalled/registries"],
      ["POST", "/api/admin/preinstalled/registries"],
      ["GET", "/api/admin/preinstalled/releases"],
      ["POST", "/api/admin/preinstalled/registries/reg_1/revisions/rev_1/promote"],
    ] as const) {
      const body = method === "POST" ? {} : undefined
      expect([method, path, (await call(method, path, {as: admin, body})).status]).toEqual([method, path, 404])
    }
    expect(await AdminActionAuditLogModel.countDocuments({})).toBe(0)
  })
})

// --- The organization API under /api/admin ---------------------------------

describe("/api/admin/organization", () => {
  test("an Organization Admin's session lists every workspace, recovers ownership and manages operator keys", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const ws = await workspaceWithKey()
    const heir = await person("heir")

    const workspaces = await call("GET", "/api/admin/organization/workspaces", {as: admin})
    expect(workspaces.status).toBe(200)
    expect(workspaces.json.items.map((item: any) => item.workspaceId)).toEqual([ws.workspaceId])

    const recovered = await call("POST", `/api/admin/organization/workspaces/${ws.workspaceId}/owners`, {
      as: admin,
      body: {mentraUserId: heir.mentraUserId},
    })
    expect(recovered.status).toBe(200)
    expect(recovered.json).toMatchObject({workspaceId: ws.workspaceId, status: "active"})
    const heirMe = await call("GET", "/api/admin/me", {as: heir})
    expect(heirMe.json.workspaces.map((item: any) => [item.workspaceId, item.membership.role])).toEqual([
      [ws.workspaceId, "owner"],
    ])

    const created = await call("POST", "/api/admin/organization/credentials", {
      as: admin,
      body: {name: "ops", scopes: ["organization.incidents.read"]},
    })
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const {token, credential} = created.json
    expect(token).toMatch(/^mak_local_/)
    const listed = await call("GET", "/api/admin/organization/credentials", {as: admin})
    expect(listed.json.items.map((item: any) => item.credentialId)).toEqual([credential.credentialId])
    expect(listed.text).not.toContain(token)
    expect((await call("GET", "/api/admin/reports", {as: token})).status).toBe(200)

    const revoked = await call("DELETE", `/api/admin/organization/credentials/${credential.credentialId}`, {as: admin})
    expect(revoked.status).toBe(204)
    expect((await call("GET", "/api/admin/organization/credentials", {as: admin})).json.items).toEqual([])
    expect((await call("GET", "/api/admin/reports", {as: token})).status).toBe(401)
  })

  test("a cookie write that does not come from the admin portal is refused before anything is created", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const origin of ["https://evil.test", "https://portal.test"]) {
      const reply = await call("POST", "/api/admin/organization/credentials", {
        as: admin,
        headers: {origin},
        body: {name: "ops", scopes: ["organization.incidents.read"]},
      })
      expect([origin, reply.status]).toEqual([origin, 403])
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("operator keys, workspace keys and people who are not Organization Admins are refused", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const ws = await workspaceWithKey()
    const operator = await operatorKey("all-scopes", OPERATOR_KEY_SCOPES)
    const stranger = await person("stranger")
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})
    const routes: Array<[method: string, path: string, body?: unknown]> = [
      ["GET", "/api/admin/organization/workspaces"],
      ["POST", `/api/admin/organization/workspaces/${ws.workspaceId}/owners`, {mentraUserId: stranger.mentraUserId}],
      ["GET", "/api/admin/organization/credentials"],
      ["POST", "/api/admin/organization/credentials", {name: "sneaky", scopes: ["organization.incidents.read"]}],
      ["DELETE", `/api/admin/organization/credentials/${operator.credentialId}`],
    ]

    for (const [label, caller, via] of [
      ["operator key", operator.token, undefined],
      ["workspace key", ws.token, undefined],
      ["workspace owner", ws.owner, "session"],
      ["workspace owner", ws.owner, "bearer"],
      ["stranger", stranger, "session"],
      ["unverified allowlisted address", claimed, "session"],
      ["unverified allowlisted address", claimed, "bearer"],
    ] as const) {
      for (const [method, path, body] of routes) {
        const reply = await call(method, path, {as: caller, via, body})
        const route = `${label} (${via ?? "key"}): ${method} ${path}`
        expect({route, status: reply.status}).toEqual({route, status: 403})
        expect(reply.json.error).toBe("forbidden")
      }
    }
    // Without a principal it is 401 (from the admin portal's origin: a write from anywhere else is refused
    // as cross-site first).
    for (const [method, path, body] of routes) {
      const anonymous = await call(method, path, {body, headers: {origin: ADMIN_ORIGIN}})
      expect([method, path, anonymous.status]).toEqual([method, path, 401])
    }

    // Nothing moved: the operator key is live, no other key exists and the stranger owns nothing.
    const keys = await call("GET", "/api/admin/organization/credentials", {as: admin})
    expect(keys.json.items.map((item: any) => item.credentialId)).toEqual([operator.credentialId])
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: stranger.mentraUserId})).toBe(0)
  })

  test("GET /api/admin/organization tells any principal what it may do", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const ws = await workspaceWithKey()
    const operator = await operatorKey("testing", ["organization.testing.read"])

    expect((await call("GET", "/api/admin/organization", {as: admin})).json).toEqual({
      capabilities: [...ORGANIZATION_CAPABILITIES],
      workspaceCreation: {allowed: true, reason: null},
    })
    expect((await call("GET", "/api/admin/organization", {as: ws.owner})).json).toEqual({
      capabilities: [],
      workspaceCreation: {allowed: true, reason: null},
    })
    expect((await call("GET", "/api/admin/organization", {as: operator.token})).json).toEqual({
      capabilities: ["organization.testing.read"],
      workspaceCreation: {allowed: false, reason: "not_a_person"},
    })
    expect((await call("GET", "/api/admin/organization", {as: ws.token})).json).toEqual({
      capabilities: [],
      workspaceCreation: {allowed: false, reason: "not_a_person"},
    })
    expect((await call("GET", "/api/admin/organization")).status).toBe(401)
  })
})
