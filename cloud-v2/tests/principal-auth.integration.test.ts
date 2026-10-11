/**
 * @fileoverview Principal resolution on Core's portal APIs (L05, L06, L07,
 * Review Focus 4): Core credentials, identity-provider bearers and portal
 * session cookies, each only where it belongs.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
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
import {DeveloperApiKeyService} from "../packages/core/src/services/developer-orgs/developer-api-key.service"
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
  await Promise.all([UserModel.deleteMany({}), BrowserSessionModel.deleteMany({}), DeveloperOrgApiKeyModel.deleteMany({})])
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
  return idp.mint({sub: "supa-admin", aud: "authenticated", client_id: "console-client", email: ADMIN_EMAIL, ...claims})
}

describe("identity-provider bearers", () => {
  test("a Supabase access token is a bearer on the admin and enterprise portal APIs", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    const token = await supabaseToken()
    const admin = await adminMe({authorization: `Bearer ${token}`})
    expect(admin.status).toBe(200)
    expect(((await admin.json()) as {principal: {mentraUserId: string}}).principal.mentraUserId).toBe(phoneUser.mentraUserId)
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

  test("a Supabase ID token is refused (L07)", async () => {
    const idToken = await supabaseToken({aud: "console-client"})
    expect((await adminMe({authorization: `Bearer ${idToken}`})).status).toBe(401)
  })

  test("an invalid bearer never falls back to a valid cookie", async () => {
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity)
    expect((await adminMe({authorization: "Bearer not-a-token", cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(401)
  })

  test("an identity provider outage answers 503, never success", async () => {
    const token = await idp.mint({sub: "supa-admin", aud: "authenticated", client_id: "console-client"}, {alg: "ES256"})
    idp.outage = true
    const response = await adminMe({authorization: `Bearer ${token}`})
    expect(response.status).toBe(503)
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

  test("a cookie named like Supabase's authenticates nothing, even holding a valid token", async () => {
    const token = await supabaseToken()
    const cookie = `sb-access-token=${token}; sb-signin-auth-token=${token}`
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

describe("Organization Admins (L06)", () => {
  test("removing an email from CLOUD_CORE_ADMIN_EMAILS removes admin access on the next request", async () => {
    const {cookieValue: session} = await createPortalSession("admin", adminIdentity)
    expect((await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(200)
    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@mentra.glass"
    expect((await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(403)
  })

  test("an unverified allowlisted email is not an Organization Admin", async () => {
    const {cookieValue: session} = await createPortalSession("admin", {...adminIdentity, emailVerified: false})
    expect((await adminMe({cookie: `${ADMIN_COOKIE}=${session}`})).status).toBe(403)
  })
})

describe("admin keys keep working", () => {
  test("an existing allowlisted admin key reads incidents", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "incident reader", "seed", "local")
    process.env.CLOUD_CORE_ADMIN_EMAILS = `${ADMIN_EMAIL},api-key@${key.id}.local`
    const reports = await app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers: {authorization: `Bearer ${key.value}`}})
    expect(reports.status).toBe(200)
    const me = await adminMe({authorization: `Bearer ${key.value}`})
    expect(me.status).toBe(200)
    expect(((await me.json()) as {principal: {kind: string; credentialId: string}}).principal).toEqual({kind: "credential", credentialId: key.id})
  })

  test("a key that is not allowlisted gets 403, an invalid one 401", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "not admin", "seed", "local")
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers: {authorization: `Bearer ${key.value}`}})).status).toBe(403)
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers: {authorization: "Bearer msk_local_01ABC.secret"}})).status).toBe(401)
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers: {authorization: "Bearer mak_local_01ABC.secret"}})).status).toBe(401)
  })

  test("a key gets 403 on the enterprise portal API, which is for people", async () => {
    const key = await new DeveloperApiKeyService().create("org_ops", "key", "seed", "local")
    process.env.CLOUD_CORE_ADMIN_EMAILS = `api-key@${key.id}.local`
    expect((await portalMe({authorization: `Bearer ${key.value}`})).status).toBe(403)
  })
})
