/**
 * @fileoverview Portal sign-in for the admin and workspace portals through
 * Core's sign-in server (L01, L02, L03, L04, L05, L06, L12, Review Focus 1
 * and 2).
 *
 * Runs Core's real routes in-process. The portals are confidential clients of
 * Core's own provider, which fronts a fake Supabase (hosted Core, through the
 * sign-in page's hand-off) or a fake Entra (a Private Cloud, on Core's one
 * host). Every round trip goes through openid-client's code exchange.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/portal-signin.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {DeveloperOrgApiKeyModel} from "../packages/core/src/models/developer-org-api-key.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {DeveloperApiKeyService} from "../packages/core/src/services/developer-orgs/developer-api-key.service"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {ensureOidcCollections} from "../packages/core/src/services/oidc/mongo-adapter"
import {resetUpstreamCaches} from "../packages/core/src/services/oidc/upstream"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {
  portalClient,
  resetPortalSigninCaches,
  SignInRefused,
  verifyPortalIdToken,
} from "../packages/core/src/services/signin/portal-signin.service"
import {convertLegacyAdminKeys} from "../packages/core/src/services/workspaces/legacy-admin-keys"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {routeOriginsToApp} from "./support/oidc-harness"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  ENTRA_CALLBACK,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  HOSTED_ENV,
  OIDC_ISSUER,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  portalSignIn,
  PRIVATE_CLOUD_ENV,
  setCookieLine,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
  TX_COOKIE,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const databaseUrl = localTestMongoUrl("portal-signin")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
const now = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([
    UserModel.syncIndexes(),
    BrowserSessionModel.syncIndexes(),
    LoginTransactionModel.syncIndexes(),
    AuthRateLimitModel.syncIndexes(),
    DeveloperOrgApiKeyModel.syncIndexes(),
    SigninIdentityModel.syncIndexes(),
    ensureOidcCollections(),
  ])
  for (const model of [AccessCredentialModel, WorkspaceAuditEventModel]) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  await stopOidcBridge()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
  resetCoreKeyCaches()
})

async function clean() {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all([
    UserModel.deleteMany({}),
    BrowserSessionModel.deleteMany({}),
    LoginTransactionModel.deleteMany({}),
    AuthRateLimitModel.deleteMany({}),
    DeveloperOrgApiKeyModel.deleteMany({}),
    AccessCredentialModel.deleteMany({}),
    WorkspaceAuditEventModel.deleteMany({}),
    SigninIdentityModel.deleteMany({}),
  ])
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  resetUpstreamCaches()
}

const ADMIN_PERSON = {sub: "supa-admin", email: ADMIN_EMAIL, emailConfirmed: true}

/** Signed in, and refused everything that needs an organization capability. */
async function expectNoOrganizationCapabilities(cookie: string) {
  const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie}})
  expect(me.status).toBe(200)
  expect(((await me.json()) as {organization: {capabilities: string[]}}).organization.capabilities).toEqual([])
  expect((await app.request(`${ADMIN_ORIGIN}/api/admin/reports`, {headers: {cookie}})).status).toBe(403)
}

describe("hosted Core: Supabase behind Core's sign-in server", () => {
  let idp: FakeIdp
  const tokenRequests: Array<{authorization: string | null; body: URLSearchParams}> = []

  beforeEach(async () => {
    restoreEnv = applyEnv(HOSTED_ENV)
    await clean()
    idp = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
    const restoreRoute = routeOriginsToApp(app, [OIDC_ISSUER])
    // Record the portal's code exchanges at Core's token endpoint.
    const routed = globalThis.fetch
    tokenRequests.length = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === `${OIDC_ISSUER}/oidc/token`) {
        tokenRequests.push({authorization: request.headers.get("authorization"), body: new URLSearchParams(await request.clone().text())})
      }
      return routed(request)
    }) as typeof fetch
    restoreFetch = () => {
      globalThis.fetch = routed
      restoreRoute()
    }
  })

  afterEach(() => {
    restoreFetch()
    idp.restore()
    restoreEnv()
  })

  test("an admin sign-in round trip sets the __Host- session cookie and /me resolves the phone's Core user (L01, L05)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, returnTo: "/?report=rep_1"})
    expect(result.done.status).toBe(302)
    expect(result.done.headers.get("location")).toBe("/?report=rep_1")
    const line = setCookieLine(result.done, ADMIN_COOKIE)!
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/Secure/i)
    expect(line).toMatch(/SameSite=Lax/i)
    expect(line).toMatch(/Path=\//i)
    expect(line).not.toMatch(/Domain=/i)
    // Only the hash of the cookie value is stored.
    expect(JSON.stringify(await BrowserSessionModel.find({}).lean())).not.toContain(result.sessionCookie!)
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${result.sessionCookie}`}})
    expect(me.status).toBe(200)
    expect(((await me.json()) as {user: {mentraUserId: string; email: string; emailVerified: boolean}}).user).toMatchObject({
      mentraUserId: phoneUser.mentraUserId,
      email: ADMIN_EMAIL,
      emailVerified: true,
    })
  })

  test("the authorize request goes to Core's issuer: openid email profile, nonce, S256 PKCE, the registered redirect", async () => {
    const {authorizeUrl} = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${OIDC_ISSUER}/oidc/auth`)
    expect(authorizeUrl.searchParams.get("client_id")).toBe("admin-portal")
    expect(authorizeUrl.searchParams.get("scope")).toBe("openid email profile")
    expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy()
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ADMIN_ORIGIN}/api/admin/auth/callback`)
  })

  test("the redirect URI comes from configuration even with forwarding headers set", async () => {
    const {authorizeUrl} = await portalSignIn(app, idp, {
      portal: "admin",
      person: ADMIN_PERSON,
      loginHeaders: {"x-forwarded-host": "evil.test", "x-mentra-public-origin": "https://evil.test", host: "evil.test"},
    })
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ADMIN_ORIGIN}/api/admin/auth/callback`)
  })

  test("an unsafe return_to falls back to / (Review Focus 1)", async () => {
    const {done} = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, returnTo: "//evil.test/x"})
    expect(done.headers.get("location")).toBe("/")
  })

  test("the code exchange authenticates with client_secret_post and requests no refresh token", async () => {
    const {done} = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    expect(done.status).toBe(302)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]!.authorization).toBeNull()
    expect(tokenRequests[0]!.body.get("client_id")).toBe("admin-portal")
    expect(tokenRequests[0]!.body.get("client_secret")).toBeTruthy()
    expect(tokenRequests[0]!.body.get("grant_type")).toBe("authorization_code")
  })

  test("a second portal in the same browser signs in without credentials (single sign-on, L02)", async () => {
    const first = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const handoffsBefore = idp.logoutCalls.length
    const second = await portalSignIn(app, idp, {portal: "portal", person: {sub: "never-asked"}, browser: first.browser})
    expect(second.done.status).toBe(302)
    expect(second.sessionCookie).toBeTruthy()
    // No second hand-off happened: the provider's own session signed the person in.
    expect(idp.logoutCalls.length).toBe(handoffsBefore)
    const me = await app.request(`${PORTAL_ORIGIN}/api/portal/me`, {headers: {cookie: `${PORTAL_COOKIE}=${second.sessionCookie}`}})
    expect(((await me.json()) as {user: {email: string}}).user.email).toBe(ADMIN_EMAIL)
  })

  test("signing out on the sign-in site ends the provider session and leaves the portal session working (L12)", async () => {
    const first = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const confirm = await first.browser.request(`${OIDC_ISSUER}/oidc/session/end`)
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(await confirm.text())![1]!
    await first.browser.request(`${OIDC_ISSUER}/oidc/session/end/confirm`, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", origin: OIDC_ISSUER},
      body: new URLSearchParams({xsrf, logout: "yes"}).toString(),
    })
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${first.sessionCookie}`}})
    expect(me.status).toBe(200)
    // The next portal sign-in in that browser asks for credentials again (a new hand-off).
    const handoffs = idp.logoutCalls.length
    await portalSignIn(app, idp, {portal: "portal", person: ADMIN_PERSON, browser: first.browser})
    expect(idp.logoutCalls.length).toBe(handoffs + 1)
  })

  test("a deleted account cannot sign in, and its open portal session stops working", async () => {
    const {sessionCookie} = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${sessionCookie}`}})).status).toBe(401)
    const again = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    expect(again.sessionCookie).toBeNull()
  })

  describe("each creates no session (L04)", () => {
    async function expectNoSession(result: Awaited<ReturnType<typeof portalSignIn>>) {
      expect(result.sessionCookie).toBeNull()
      expect(result.done.status).toBeGreaterThanOrEqual(400)
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    }

    test("a replayed state", async () => {
      const first = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
      expect(first.sessionCookie).toBeTruthy()
      await BrowserSessionModel.deleteMany({})
      const replay = await app.request(first.callbackUrl.href, {headers: {cookie: `${TX_COOKIE}=${first.txCookie}`}})
      expect(replay.status).toBe(400)
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    })

    test("a wrong state", async () => {
      await expectNoSession(
        await portalSignIn(app, idp, {
          portal: "admin",
          person: ADMIN_PERSON,
          tamper: callback => {
            callback.searchParams.set("state", "forged")
            return callback
          },
        }),
      )
    })

    test("a missing transaction cookie", async () => {
      await expectNoSession(await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, omitTxCookie: true}))
    })

    test("the workspace portal's code on the admin callback", async () => {
      await expectNoSession(
        await portalSignIn(app, idp, {
          portal: "portal",
          person: ADMIN_PERSON,
          tamper: callback => new URL(`${ADMIN_ORIGIN}/api/admin/auth/callback${callback.search}`),
        }),
      )
    })

    test("a Supabase session that started before the person's revocation", async () => {
      const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
      await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((now() - 60) * 1000)}})
      await expectNoSession(await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, sessionStartedAt: now() - 120}))
    })
  })

  describe("the portal verifies the ID token with Core's key (L04)", () => {
    const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}, key?: jose.KeyLike) => {
      const signingKey =
        key ?? (await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${process.env.MENTRA_JWT_PRIVATE_KEY}\n-----END PRIVATE KEY-----`, "EdDSA"))
      return new jose.SignJWT({nonce: "n-1", email: ADMIN_EMAIL, email_verified: true, ...claims})
        .setProtectedHeader({alg: "EdDSA", kid: "mentra-oidc-1", ...header})
        .setIssuer((claims.iss as string) ?? OIDC_ISSUER)
        .setAudience((claims.aud as string | string[]) ?? "admin-portal")
        .setSubject((claims.sub as string) ?? "")
        .setIssuedAt()
        .setExpirationTime((claims.exp as number) ?? now() + 600)
        .sign(signingKey)
    }

    async function signedIn() {
      await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
      return (await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})).mentraUserId
    }

    test("a valid one names the person", async () => {
      const sub = await signedIn()
      expect(await verifyPortalIdToken(portalClient("admin"), await sign({sub}), "n-1")).toMatchObject({mentraUserId: sub, tenantId: "mentra"})
    })

    test.each([
      ["another environment's issuer", {iss: "https://account.staging.test"}, {}],
      ["another client's audience", {aud: "workspace-portal"}, {}],
      ["several audiences and the wrong azp", {aud: ["admin-portal", "console"], azp: "console"}, {}],
      ["a wrong nonce", {nonce: "forged"}, {}],
      ["an expired token", {exp: now() - 600}, {}],
      ["an access token's type", {}, {typ: "at+jwt"}],
      ["another key ID", {}, {kid: "mentra-access-1"}],
      ["a non-string type", {}, {typ: 1}],
    ])("refuses %s", async (_label, claims, header) => {
      const sub = await signedIn()
      await expect(verifyPortalIdToken(portalClient("admin"), await sign({sub, ...claims}, header), "n-1")).rejects.toBeInstanceOf(SignInRefused)
    })

    test("refuses a token signed with any other key", async () => {
      const sub = await signedIn()
      const {privateKey} = await jose.generateKeyPair("EdDSA")
      await expect(verifyPortalIdToken(portalClient("admin"), await sign({sub}, {}, privateKey), "n-1")).rejects.toBeInstanceOf(SignInRefused)
    })
  })

  test("two concurrent callbacks with one transaction create one session (Review Focus 2)", async () => {
    const first = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, omitTxCookie: true})
    await BrowserSessionModel.deleteMany({})
    await AuthRateLimitModel.deleteMany({})
    // The code was not redeemed (no transaction cookie), so the two tabs race on one transaction and one code.
    const results = await Promise.all(
      [0, 1].map(() => app.request(first.callbackUrl.href, {headers: {cookie: `${TX_COOKIE}=${first.txCookie}`}})),
    )
    expect(results.filter(response => response.status === 302)).toHaveLength(1)
    expect(await BrowserSessionModel.countDocuments({})).toBe(1)
  })

  test("an unverified allowlisted email signs in but gets no admin access (L06)", async () => {
    const {sessionCookie} = await portalSignIn(app, idp, {portal: "admin", person: {...ADMIN_PERSON, emailConfirmed: false}})
    expect(sessionCookie).toBeTruthy()
    await expectNoOrganizationCapabilities(`${ADMIN_COOKIE}=${sessionCookie}`)
  })

  test("a cross-origin POST with the admin cookie gets 403; the same POST with a key bearer is unaffected", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const cookie = `${ADMIN_COOKIE}=${result.sessionCookie}`
    const path = `${ADMIN_ORIGIN}/api/admin/submissions/0123456789abcdef01234567/reject`
    const crossOrigin = await app.request(path, {method: "POST", headers: {cookie, origin: "https://evil.example", "content-type": "application/json"}, body: "{}"})
    expect(crossOrigin.status).toBe(403)
    const noOrigin = await app.request(path, {method: "POST", headers: {cookie, "sec-fetch-site": "cross-site", "content-type": "application/json"}, body: "{}"})
    expect(noOrigin.status).toBe(403)
    const sameOrigin = await app.request(path, {method: "POST", headers: {cookie, origin: ADMIN_ORIGIN, "content-type": "application/json"}, body: "{}"})
    expect(sameOrigin.status).not.toBe(403)
    expect(sameOrigin.status).not.toBe(401)

    // An operator key (here an admin key converted at startup) with the testing scope writes from anywhere.
    const key = await new DeveloperApiKeyService().create("org_admin_keys", "ops", "seed", "local")
    const restore = applyEnv({CLOUD_CORE_ADMIN_EMAILS: `${ADMIN_EMAIL},api-key@${key.id}.local`})
    try {
      await convertLegacyAdminKeys()
      const bearer = await app.request(`${ADMIN_ORIGIN}/api/admin/test-dispatches/picker`, {method: "POST", headers: {authorization: `Bearer ${key.value}`, origin: "https://evil.example", "content-type": "application/json"}, body: "{}"})
      expect(bearer.status).not.toBe(403)
      expect(bearer.status).not.toBe(401)
    } finally {
      restore()
    }
  })

  test("logout is same-origin only, ends the portal session, and offers the sign-in site's sign-out", async () => {
    const {sessionCookie} = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const cookie = `${ADMIN_COOKIE}=${sessionCookie}`
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/auth/logout`, {method: "POST", headers: {cookie, origin: "https://evil.test"}})).status).toBe(403)
    const out = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/logout`, {method: "POST", headers: {cookie, origin: ADMIN_ORIGIN}})
    expect(out.status).toBe(200)
    expect(out.headers.get("cache-control")).toBe("no-store")
    expect(await out.json()).toEqual({signOutUrl: `${OIDC_ISSUER}/oidc/session/end`})
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie}})).status).toBe(401)
  })

  test("the workspace portal signs in with its own client and cookie", async () => {
    const {authorizeUrl, sessionCookie, done} = await portalSignIn(app, idp, {portal: "portal", person: ADMIN_PERSON})
    expect(authorizeUrl.searchParams.get("client_id")).toBe("workspace-portal")
    expect(setCookieLine(done, PORTAL_COOKIE)).toBeTruthy()
    expect((await app.request(`${PORTAL_ORIGIN}/api/portal/me`, {headers: {cookie: `${PORTAL_COOKIE}=${sessionCookie}`}})).status).toBe(200)
  })

  test("login and callback answer 429 past their per-IP limits", async () => {
    const headers = {"x-forwarded-for": "198.51.100.7"}
    const logins = await Promise.all(Array.from({length: 21}, () => app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {headers})))
    expect(logins.filter(response => response.status === 429)).toHaveLength(1)
    const callbacks = await Promise.all(Array.from({length: 31}, () => app.request(`${ADMIN_ORIGIN}/api/admin/auth/callback?state=x`, {headers})))
    expect(callbacks.filter(response => response.status === 429)).toHaveLength(1)
  })
})

describe("portal sign-in not configured", () => {
  beforeEach(async () => {
    restoreEnv = applyEnv({...HOSTED_ENV, CLOUD_CORE_OIDC_ISSUER: undefined})
    await clean()
  })
  afterEach(() => restoreEnv())

  test("login renders a fixed 'not configured' page instead of failing", async () => {
    const response = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("Sign-in is not configured")
  })

  test("a portal whose callback is not registered at Core's sign-in server is not configured", async () => {
    restoreEnv()
    restoreEnv = applyEnv({...HOSTED_ENV, CLOUD_CORE_ADMIN_PORTAL_URL: "https://admin.elsewhere.test"})
    expect((await app.request("https://admin.elsewhere.test/api/admin/auth/login")).status).toBe(503)
  })

  test("the admin API still answers 401 without a principal", async () => {
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/me`)).status).toBe(401)
  })
})

describe("a Private Cloud: Entra behind Core's sign-in server, on Core's one host", () => {
  let entra: FakeIdp

  beforeEach(async () => {
    restoreEnv = applyEnv(PRIVATE_CLOUD_ENV)
    await clean()
    entra = await installFakeIdp({
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      kind: "oidc",
      clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [ENTRA_CALLBACK]}],
    })
    restoreFetch = routeOriginsToApp(app, [ADMIN_ORIGIN])
  })

  afterEach(() => {
    restoreFetch()
    entra.restore()
    restoreEnv()
  })

  const entraPerson = (oid: string, email = "it-admin@contoso.com", extra: Record<string, unknown> = {}) => ({
    sub: `pairwise-${oid}`,
    email,
    claims: {oid, tid: ENTRA_TENANT},
    ...extra,
  })

  test("an Entra admin signs in and resolves the phone's Core user by oid (L03)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "oid-admin"})
    const {sessionCookie, authorizeUrl} = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-admin")})
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${ADMIN_ORIGIN}/oidc/auth`)
    expect(sessionCookie).toBeTruthy()
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${sessionCookie}`}})
    const body = (await me.json()) as {user: {mentraUserId: string; isOrganizationAdmin: boolean}; organization: {capabilities: string[]}}
    expect(body.user).toMatchObject({mentraUserId: phoneUser.mentraUserId, isOrganizationAdmin: true})
    expect(body.organization.capabilities).toContain("organization.workspaces.administer")
  })

  test("a deleted account cannot sign in with its provider", async () => {
    const user = await findOrCreateUser({tenantId: "contoso", tenantUserId: "oid-deleted"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
    const {sessionCookie} = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-deleted")})
    expect(sessionCookie).toBeNull()
  })

  test("a provider email outside verifiedEmailDomains signs in without organization capabilities (L06)", async () => {
    restoreEnv()
    restoreEnv = applyEnv({...PRIVATE_CLOUD_ENV, CLOUD_CORE_ADMIN_EMAILS: "alex@mentra.glass"})
    const {sessionCookie} = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-outsider", "alex@mentra.glass")})
    expect(sessionCookie).toBeTruthy()
    await expectNoOrganizationCapabilities(`${ADMIN_COOKIE}=${sessionCookie}`)
  })

  describe("each creates no session (L04)", () => {
    const refused = async (idTokenClaims: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const {sessionCookie} = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-refused", undefined, {idTokenClaims, ...extra})})
      expect(sessionCookie).toBeNull()
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    }
    test("a wrong issuer", () => refused({iss: "https://login.microsoftonline.com/other/v2.0"}))
    test("a wrong audience", () => refused({aud: "someone-else"}))
    test("several audiences and the wrong azp", () => refused({aud: [CORE_API_CLIENT, "other-app"], azp: "other-app"}))
    test("a wrong nonce", () => refused({nonce: "forged-nonce"}))
    test("alg HS256", () => refused({}, {idTokenAlg: "HS256"}))
    test("an expired ID token", () => refused({iat: now() - 7200, exp: now() - 600}))
    test("another directory", () => refused({tid: "other-directory"}))
  })

  test("the workspace portal is not configured on a Private Cloud", async () => {
    expect((await app.request(`${PORTAL_ORIGIN}/api/portal/auth/login`)).status).toBe(503)
  })

})
