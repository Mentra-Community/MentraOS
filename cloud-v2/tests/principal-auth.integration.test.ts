/**
 * @fileoverview Principal resolution on Core's portal and workspace APIs (L05,
 * L06, L07, Review Focus 4): Core credentials, identity-provider bearers and
 * portal session cookies, each only where it belongs. The workspace API is
 * mounted under three route groups (`/api/portal/workspaces`,
 * `/api/admin/workspaces`, `/api/workspaces`); each reads only its own cookie,
 * and `/api/workspaces` none.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Converting an admin key runs a transaction, so the Mongo must be a replica set.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/principal-auth.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {DeveloperOrgApiKeyModel} from "../packages/core/src/models/developer-org-api-key.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {DeveloperApiKeyService} from "../packages/core/src/services/developer-orgs/developer-api-key.service"
import {convertLegacyAdminKeys} from "../packages/core/src/services/workspaces/legacy-admin-keys"
import {
  createPortalSession,
  SESSION_ROTATE_AFTER_MS,
  type SessionIdentity,
} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {sha256Hex} from "../packages/core/src/services/signin/random"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  coreAccessToken,
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  cookieValue,
  HOSTED_ENV,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const databaseUrl = localTestMongoUrl("principal-auth")
const WORKSPACE_MODELS = [AccessCredentialModel, WorkspaceAuditEventModel, WorkspaceMembershipModel, WorkspaceModel] as const
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

const adminIdentity: SessionIdentity = {
  mentraUserId: "mu_admin",
  tenantId: "mentra",
  sourceId: "mentra",
  subject: "supa-admin",
  email: ADMIN_EMAIL,
  emailVerified: true,
  authTime: new Date(),
}

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([UserModel.syncIndexes(), BrowserSessionModel.syncIndexes(), DeveloperOrgApiKeyModel.syncIndexes()])
  for (const model of WORKSPACE_MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv(HOSTED_ENV)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all([
    UserModel.deleteMany({}),
    BrowserSessionModel.deleteMany({}),
    DeveloperOrgApiKeyModel.deleteMany({}),
    ...WORKSPACE_MODELS.map(model => model.deleteMany({})),
  ])
  resetIdpTokenCaches()
  idp = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
  idp.registerUser({sub: "supa-admin", email: ADMIN_EMAIL, emailConfirmed: true})
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

const adminMe = (headers: Record<string, string>) => app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers})
const portalMe = (headers: Record<string, string>) => app.request(`${PORTAL_ORIGIN}/api/portal/me`, {headers})

function supabaseToken(claims: Record<string, unknown> = {}) {
  return idp.mint({sub: "supa-admin", aud: "authenticated", email: ADMIN_EMAIL, ...claims})
}

/** A Core access token for the admin, as Core's sign-in server issues it. */
function adminAccessToken(overrides: Partial<Parameters<typeof coreAccessToken>[0]> = {}) {
  return coreAccessToken({sub: "supa-admin", email: ADMIN_EMAIL, emailVerified: true, ...overrides})
}

describe("Core access token bearers", () => {
  test("a Core access token is a bearer on the admin and workspace portal APIs", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    const token = await adminAccessToken()
    const admin = await adminMe({authorization: `Bearer ${token}`})
    expect(admin.status).toBe(200)
    expect(((await admin.json()) as {user: {mentraUserId: string}}).user.mentraUserId).toBe(phoneUser.mentraUserId)
    const portal = await portalMe({authorization: `Bearer ${token}`})
    expect(portal.status).toBe(200)
  })

  test("a phone Core access token is refused (L07)", async () => {
    const {privateKey} = await jose.generateKeyPair("EdDSA")
    const coreToken = await new jose.SignJWT({tenant_id: "mentra", session_id: "sess_1"})
      .setProtectedHeader({alg: "EdDSA", kid: "access"})
      .setIssuer("cloud-core")
      .setAudience("cloud-core")
      .setSubject("mu_phone")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey)
    expect((await adminMe({authorization: `Bearer ${coreToken}`})).status).toBe(401)
    expect((await portalMe({authorization: `Bearer ${coreToken}`})).status).toBe(401)
  })

  test("Supabase tokens, Core's own ID tokens and another environment's Core access tokens are refused (L07)", async () => {
    const supabaseAccess = await supabaseToken()
    const supabaseOAuth = await supabaseToken({client_id: "console-client"})
    const restore = applyEnv({CLOUD_CORE_OIDC_ISSUER: "https://account.staging.test"})
    const otherEnvironment = await adminAccessToken()
    restore()
    const idTokenShaped = await adminAccessToken({claims: {aud: "admin-portal"}})
    for (const token of [supabaseAccess, supabaseOAuth, otherEnvironment, idTokenShaped]) {
      expect((await adminMe({authorization: `Bearer ${token}`})).status).toBe(401)
    }
  })

  test("a token from before the person's revocation is refused, and one from after is accepted (L07)", async () => {
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    const before = await adminAccessToken({iat: Math.floor(Date.now() / 1000) - 120})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date(Date.now() - 60_000)}})
    expect((await adminMe({authorization: `Bearer ${before}`})).status).toBe(401)
    expect((await adminMe({authorization: `Bearer ${await adminAccessToken()}`})).status).toBe(200)
  })

  test("an invalid bearer never falls back to a valid cookie", async () => {
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity)
    expect((await adminMe({authorization: "Bearer not-a-token", cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(401)
  })
})

describe("portal cookies authenticate only their own route group (L05, Review Focus 4)", () => {
  test("an admin session cookie on the enterprise portal API gets 401", async () => {
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity)
    expect((await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(200)
    expect((await portalMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(401)
    expect((await portalMe({cookie: `${PORTAL_COOKIE}=${session}`})).status).toBe(401)
  })

  test("an enterprise portal session cookie on the admin API gets 401", async () => {
    const {cookieValue: session} = await createPortalSession("portal", adminIdentity)
    expect((await portalMe({cookie: `${PORTAL_COOKIE}=${session}`})).status).toBe(200)
    expect((await adminMe({cookie: `${PORTAL_COOKIE}=${session}`})).status).toBe(401)
    expect((await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(401)
  })

  test("a cookie named like Supabase's, or the sign-in server's own, authenticates nothing, even holding a valid token", async () => {
    const token = await adminAccessToken()
    const cookie = `sb-access-token=${token}; sb-signin-auth-token=${token}; __Host-mentra_oidc_session=${token}`
    expect((await adminMe({cookie})).status).toBe(401)
    expect((await portalMe({cookie})).status).toBe(401)
  })

  test("a session due for rotation answers with a new cookie value", async () => {
    const createdAt = new Date(Date.now() - SESSION_ROTATE_AFTER_MS - 60_000)
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity, createdAt)
    const response = await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})
    expect(response.status).toBe(200)
    const rotated = cookieValue(response, ADMIN_COOKIE)
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(session)
    const row = await BrowserSessionModel.findOne({tokenHash: sha256Hex(rotated!)}).lean()
    expect(row?.previousTokenHash).toBe(sha256Hex(session))
  })
})

const adminReports = (headers: Record<string, string>) => app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers})
const capabilitiesOf = async (response: Response) =>
  ((await response.json()) as {organization: {capabilities: string[]}}).organization.capabilities

describe("Organization Admins (L06)", () => {
  test("removing an email from CLOUD_CORE_ADMIN_EMAILS removes admin access on the next request", async () => {
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity)
    expect((await adminReports({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(200)
    expect(await capabilitiesOf(await adminMe({cookie: `${ADMIN_COOKIE}=${session}`}))).toContain("organization.incidents.read")
    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@mentra.glass"
    expect((await adminReports({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(403)
    // Signing in still works; it grants no organization capability by itself.
    const me = await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})
    expect(me.status).toBe(200)
    expect(await capabilitiesOf(me)).toEqual([])
  })

  test("an unverified allowlisted email is not an Organization Admin", async () => {
    const {cookieValue: session} = await createPortalSession("admin", {...adminIdentity, emailVerified: false})
    expect((await adminReports({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(403)
    expect(await capabilitiesOf(await adminMe({cookie: `${ADMIN_COOKIE}=${session}`}))).toEqual([])
  })
})

describe("admin keys keep working", () => {
  test("an existing allowlisted admin key reads incidents once Core converts it at startup", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "incident reader", "seed", "local")
    process.env.CLOUD_CORE_ADMIN_EMAILS = `${ADMIN_EMAIL},api-key@${key.id}.local`
    expect((await convertLegacyAdminKeys()).converted).toEqual([key.id])
    const reports = await adminReports({authorization: `Bearer ${key.value}`})
    expect(reports.status).toBe(200)
    const me = await adminMe({authorization: `Bearer ${key.value}`})
    expect(me.status).toBe(200)
    const body = (await me.json()) as {credential: {credentialId: string; credentialKind: string}; organization: {capabilities: string[]}}
    expect(body.credential).toMatchObject({credentialId: key.id, credentialKind: "organization"})
    expect(body.organization.capabilities.sort()).toEqual([
      "organization.incidents.read",
      "organization.supportProfiles.read",
      "organization.testing.manage",
      "organization.testing.read",
    ])
  })

  test("a key that is not allowlisted is no principal, and neither is an invalid one", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "not admin", "seed", "local")
    expect((await convertLegacyAdminKeys()).converted).toEqual([])
    expect((await adminReports({authorization: `Bearer ${key.value}`})).status).toBe(401)
    expect((await adminReports({authorization: "Bearer msk_local_01ABC.secret"})).status).toBe(401)
    expect((await adminReports({authorization: "Bearer mak_local_01ABC.secret"})).status).toBe(401)
  })

  test("a key gets 403 on the enterprise portal API and the workspace API, which are for people", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "key", "seed", "local")
    process.env.CLOUD_CORE_ADMIN_EMAILS = `api-key@${key.id}.local`
    await convertLegacyAdminKeys()
    expect((await portalMe({authorization: `Bearer ${key.value}`})).status).toBe(403)
    expect((await app.request(`${ADMIN_ORIGIN}/api/workspaces`, {headers: {authorization: `Bearer ${key.value}`}})).status).toBe(403)
    expect((await app.request(`${ADMIN_ORIGIN}/api/organization/credentials`, {headers: {authorization: `Bearer ${key.value}`}})).status).toBe(403)
  })
})

describe("the workspace API under each route group", () => {
  const list = (origin: string, path: string, headers: Record<string, string>) =>
    app.request(`${origin}${path}`, {headers})

  test("each portal's cookie works only under its own group, and /api/workspaces reads no cookie", async () => {
    const {cookieValue: portalSession} = await createPortalSession("portal", adminIdentity)
    const {cookieValue: adminSession} = await createPortalSession("admin", adminIdentity)
    const portalCookie = {cookie: `${PORTAL_COOKIE}=${portalSession}`}
    const adminCookie = {cookie: `${ADMIN_COOKIE}=${adminSession}`}

    expect((await list(PORTAL_ORIGIN, "/api/portal/workspaces", portalCookie)).status).toBe(200)
    expect((await list(PORTAL_ORIGIN, "/api/portal/workspaces", adminCookie)).status).toBe(401)
    expect((await list(ADMIN_ORIGIN, "/api/admin/workspaces", adminCookie)).status).toBe(200)
    expect((await list(ADMIN_ORIGIN, "/api/admin/workspaces", portalCookie)).status).toBe(401)
    expect((await list(ADMIN_ORIGIN, "/api/admin/organization/workspaces", adminCookie)).status).toBe(200)
    expect((await list(PORTAL_ORIGIN, "/api/admin/organization/workspaces", portalCookie)).status).toBe(401)
    for (const cookie of [portalCookie, adminCookie]) {
      expect((await list(ADMIN_ORIGIN, "/api/workspaces", cookie)).status).toBe(401)
      expect((await list(ADMIN_ORIGIN, "/api/organization", cookie)).status).toBe(401)
    }
  })

  test("a Core access token works under every group", async () => {
    const bearer = {authorization: `Bearer ${await adminAccessToken()}`}
    expect((await list(ADMIN_ORIGIN, "/api/workspaces", bearer)).status).toBe(200)
    expect((await list(PORTAL_ORIGIN, "/api/portal/workspaces", bearer)).status).toBe(200)
    expect((await list(ADMIN_ORIGIN, "/api/admin/workspaces", bearer)).status).toBe(200)
    expect((await list(ADMIN_ORIGIN, "/api/organization", bearer)).status).toBe(200)
  })

  test("a cross-origin POST with the portal cookie is refused before anything is created", async () => {
    const {cookieValue: session} = await createPortalSession("portal", adminIdentity)
    const create = (origin: string) =>
      app.request(`${PORTAL_ORIGIN}/api/portal/workspaces`, {
        method: "POST",
        headers: {cookie: `${PORTAL_COOKIE}=${session}`, origin, "content-type": "application/json"},
        body: JSON.stringify({name: "Acme"}),
      })
    expect((await create("https://evil.test")).status).toBe(403)
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
    expect((await create(PORTAL_ORIGIN)).status).toBe(201)
  })
})
