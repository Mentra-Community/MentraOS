/**
 * @fileoverview Portal sign-in for the admin and enterprise portals (L01, L03,
 * L04, L05, L06, Review Focus 1 and 2).
 *
 * Runs Core's real routes in-process against a fake identity provider (fetch
 * interception): Supabase for hosted Core, Entra for a Private Cloud. Every
 * round trip goes through openid-client's code exchange.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/portal-signin.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {DeveloperOrgApiKeyModel} from "../packages/core/src/models/developer-org-api-key.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {DeveloperApiKeyService} from "../packages/core/src/services/developer-orgs/developer-api-key.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  HOSTED_ENV,
  PORTAL_COOKIE,
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
  ])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

async function clean() {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all([
    UserModel.deleteMany({}),
    BrowserSessionModel.deleteMany({}),
    LoginTransactionModel.deleteMany({}),
    AuthRateLimitModel.deleteMany({}),
    DeveloperOrgApiKeyModel.deleteMany({}),
  ])
  resetIdpTokenCaches()
  resetPortalSigninCaches()
}

const ADMIN_PERSON = {sub: "supa-admin", email: ADMIN_EMAIL, emailConfirmed: true}

describe("hosted Core (Supabase)", () => {
  let idp: FakeIdp

  beforeEach(async () => {
    restoreEnv = applyEnv(HOSTED_ENV)
    await clean()
    idp = await installFakeIdp({
      issuer: SUPABASE_ISSUER,
      jwksUrl: SUPABASE_JWKS,
      hs256Secret: SUPABASE_SECRET,
      projectUrl: SUPABASE_PROJECT,
      clients: [
        {id: "admin-client", secret: "admin-secret", redirectUris: [`${ADMIN_ORIGIN}/api/admin/auth/callback`]},
        {id: "portal-client", secret: "portal-secret", redirectUris: ["https://portal.test/api/portal/auth/callback"]},
      ],
    })
  })

  afterEach(() => {
    idp.restore()
    restoreEnv()
  })

  test("an admin sign-in round trip sets the __Host- session cookie and /me resolves the phone's Core user (L01, L05)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-admin"})
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, returnTo: "/?report=rep_1"})
    expect(result.done.status).toBe(302)
    expect(result.done.headers.get("location")).toBe("/?report=rep_1")
    expect(result.done.headers.get("cache-control")).toBe("no-store")
    const line = setCookieLine(result.done, ADMIN_COOKIE)!
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/Secure/i)
    expect(line).toMatch(/SameSite=Lax/i)
    expect(line).toMatch(/Path=\//)
    expect(line).not.toMatch(/Domain=/i)

    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${result.sessionCookie}`}})
    expect(me.status).toBe(200)
    const body = (await me.json()) as {principal: {mentraUserId: string; email: string; emailVerified: boolean}}
    expect(body.principal.mentraUserId).toBe(phoneUser.mentraUserId)
    expect(body.principal.email).toBe(ADMIN_EMAIL)
    expect(body.principal.emailVerified).toBe(true)
  })

  test("the authorize request pins email profile: no openid, no nonce, S256 PKCE, and the configured redirect", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const params = result.authorizeUrl.searchParams
    expect(params.get("scope")).toBe("email profile")
    expect(params.get("nonce")).toBeNull()
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("client_id")).toBe("admin-client")
    expect(params.get("redirect_uri")).toBe(`${ADMIN_ORIGIN}/api/admin/auth/callback`)
  })

  test("the redirect URI comes from configuration even with forwarding headers set", async () => {
    const result = await portalSignIn(app, idp, {
      portal: "admin",
      person: ADMIN_PERSON,
      loginHeaders: {"x-forwarded-host": "evil.example", "x-mentra-public-origin": "https://evil.example", host: "evil.example"},
    })
    expect(result.authorizeUrl.searchParams.get("redirect_uri")).toBe(`${ADMIN_ORIGIN}/api/admin/auth/callback`)
    expect(result.done.status).toBe(302)
  })

  test("an unsafe return_to falls back to / (Review Focus 1)", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, returnTo: "//evil.example/x"})
    expect(result.done.headers.get("location")).toBe("/")
  })

  test("the code exchange uses client_secret_post, and the portal's Supabase session is ended right after", async () => {
    await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    expect(idp.tokenRequests).toHaveLength(1)
    expect(idp.tokenRequests[0]).toMatchObject({auth: "client_secret_post", clientId: "admin-client", status: 200})
    expect(idp.logoutCalls).toHaveLength(1)
    expect(idp.logoutCalls[0]).toMatchObject({scope: "local", sub: "supa-admin", status: 204, apikey: "sb_publishable_signin_test"})
    const sessions = [...idp.sessions.values()]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.endedAt).not.toBeNull()
  })

  test("a failing Supabase logout still signs the person in", async () => {
    idp.failLogout = true
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    expect(result.done.status).toBe(302)
    expect(result.sessionCookie).toBeTruthy()
  })

  describe("each creates no session (L04)", () => {
    async function expectRefused(result: Awaited<ReturnType<typeof portalSignIn>>) {
      expect(result.done.status).toBe(400)
      expect(result.sessionCookie).toBeNull()
      expect(result.done.headers.getSetCookie().some(line => line.startsWith(ADMIN_COOKIE))).toBe(false)
      expect(result.done.headers.get("content-type")).toContain("text/html")
      expect(await result.done.text()).toContain("Try again")
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    }

    test("an access token issued to another client (the Console's)", async () => {
      await expectRefused(await portalSignIn(app, idp, {portal: "admin", person: {...ADMIN_PERSON, claims: {client_id: "console-client"}}}))
    })

    test("a wrong issuer", async () => {
      await expectRefused(await portalSignIn(app, idp, {portal: "admin", person: {...ADMIN_PERSON, claims: {iss: "https://other.supabase.co/auth/v1"}}}))
    })

    test("an expired access token", async () => {
      await expectRefused(await portalSignIn(app, idp, {portal: "admin", person: {...ADMIN_PERSON, claims: {iat: now() - 7200, exp: now() - 120}}}))
    })

    test("a replayed state", async () => {
      const first = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
      expect(first.done.status).toBe(302)
      await BrowserSessionModel.deleteMany({})
      const replay = await app.request(first.callbackUrl.href, {headers: {cookie: `${TX_COOKIE}=${first.txCookie}`}})
      expect(replay.status).toBe(400)
      expect(setCookieLine(replay, ADMIN_COOKIE)).toBeUndefined()
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    })

    test("a wrong state", async () => {
      await expectRefused(
        await portalSignIn(app, idp, {
          portal: "admin",
          person: ADMIN_PERSON,
          tamper: callback => {
            callback.searchParams.set("state", "forged-state")
            return callback
          },
        }),
      )
    })

    test("a missing transaction cookie", async () => {
      await expectRefused(await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, omitTxCookie: true}))
    })

    test("the enterprise portal's transaction on the admin callback", async () => {
      const login = await app.request("https://portal.test/api/portal/auth/login")
      const tx = login.headers.getSetCookie().find(line => line.startsWith(TX_COOKIE))!.split(";")[0]!
      const callback = await idp.approve(login.headers.get("location")!, ADMIN_PERSON)
      const crossed = new URL(`${ADMIN_ORIGIN}/api/admin/auth/callback${callback.search}`)
      const done = await app.request(crossed.href, {headers: {cookie: tx}})
      expect(done.status).toBe(400)
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    })
  })

  test("two concurrent callbacks with one transaction create one session (Review Focus 2)", async () => {
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    const tx = login.headers.getSetCookie().find(line => line.startsWith(TX_COOKIE))!.split(";")[0]!
    const callback = await idp.approve(login.headers.get("location")!, ADMIN_PERSON)
    const [a, b] = await Promise.all([
      app.request(callback.href, {headers: {cookie: tx}}),
      app.request(callback.href, {headers: {cookie: tx}}),
    ])
    expect([a.status, b.status].sort()).toEqual([302, 400])
    expect(await BrowserSessionModel.countDocuments({})).toBe(1)
  })

  test("an unverified allowlisted email signs in but gets no admin access (L06)", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: {sub: "supa-unverified", email: ADMIN_EMAIL, emailConfirmed: false}})
    expect(result.done.status).toBe(302)
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${result.sessionCookie}`}})
    expect(me.status).toBe(403)
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

    const key = await new DeveloperApiKeyService().create("org_admin_keys", "ops", "seed", "local")
    const restore = applyEnv({CLOUD_CORE_ADMIN_EMAILS: `${ADMIN_EMAIL},api-key@${key.id}.local`})
    try {
      const bearer = await app.request(path, {method: "POST", headers: {authorization: `Bearer ${key.value}`, origin: "https://evil.example", "content-type": "application/json"}, body: "{}"})
      expect(bearer.status).not.toBe(403)
      expect(bearer.status).not.toBe(401)
    } finally {
      restore()
    }
  })

  test("logout is same-origin only, ends the portal session, and offers the Mentra sign-out", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    const cookie = `${ADMIN_COOKIE}=${result.sessionCookie}`
    const crossOrigin = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/logout`, {method: "POST", headers: {cookie, origin: "https://evil.example"}})
    expect(crossOrigin.status).toBe(403)
    const logout = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/logout`, {method: "POST", headers: {cookie, origin: ADMIN_ORIGIN}})
    expect(logout.status).toBe(200)
    expect(logout.headers.get("cache-control")).toBe("no-store")
    expect(await logout.json()).toEqual({signOutUrl: "https://account.test/signout"})
    expect(setCookieLine(logout, ADMIN_COOKIE)).toMatch(/Max-Age=0/)
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie}})
    expect(me.status).toBe(401)
  })

  test("the enterprise portal signs in with its own client and cookie", async () => {
    const result = await portalSignIn(app, idp, {portal: "portal", person: {sub: "supa-owner", email: "owner@acme.example"}})
    expect(result.authorizeUrl.searchParams.get("client_id")).toBe("portal-client")
    expect(result.done.status).toBe(302)
    expect(setCookieLine(result.done, PORTAL_COOKIE)).toMatch(/HttpOnly.*Secure|Secure.*HttpOnly/i)
    const me = await app.request("https://portal.test/api/portal/me", {headers: {cookie: `${PORTAL_COOKIE}=${result.sessionCookie}`}})
    expect(me.status).toBe(200)
    expect(((await me.json()) as {user: {email: string}}).user.email).toBe("owner@acme.example")
  })

  test("login and callback answer 429 past their per-IP limits", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {headers: {"x-forwarded-for": "198.51.100.7"}})).status).toBe(302)
    }
    const limited = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {headers: {"x-forwarded-for": "198.51.100.7"}})
    expect(limited.status).toBe(429)
    expect(limited.headers.get("cache-control")).toBe("no-store")
    for (let i = 0; i < 30; i++) {
      await app.request(`${ADMIN_ORIGIN}/api/admin/auth/callback?state=x&code=y`, {headers: {"x-forwarded-for": "198.51.100.8"}})
    }
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/auth/callback?state=x&code=y`, {headers: {"x-forwarded-for": "198.51.100.8"}})).status).toBe(429)
  })
})

describe("portal sign-in not configured", () => {
  beforeEach(async () => {
    restoreEnv = applyEnv(Object.fromEntries(Object.keys(HOSTED_ENV).map(key => [key, undefined])))
    await clean()
  })
  afterEach(() => restoreEnv())

  test("login renders a fixed 'not configured' page instead of failing", async () => {
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login?return_to=%2Fx`)
    expect(login.status).toBe(503)
    expect(login.headers.get("cache-control")).toBe("no-store")
    expect(await login.text()).toContain("Sign-in is not configured")
    expect(login.headers.getSetCookie()).toHaveLength(0)
  })

  test("the admin API still answers 401 without a principal", async () => {
    expect((await app.request(`${ADMIN_ORIGIN}/api/admin/me`)).status).toBe(401)
  })
})

describe("Private Cloud (Entra)", () => {
  let entra: FakeIdp
  const ENTRA_PERSON = {
    sub: "entra-pairwise-sub",
    email: "it-admin@contoso.com",
    claims: {oid: "entra-oid-1", tid: ENTRA_TENANT},
  }

  beforeEach(async () => {
    restoreEnv = applyEnv(PRIVATE_CLOUD_ENV)
    await clean()
    entra = await installFakeIdp({
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      kind: "oidc",
      hs256Secret: CORE_API_SECRET,
      clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [`${ADMIN_ORIGIN}/api/admin/auth/callback`]}],
    })
  })

  afterEach(() => {
    entra.restore()
    restoreEnv()
  })

  test("an Entra admin signs in and resolves the phone's Core user by oid (L03)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "entra-oid-1"})
    const result = await portalSignIn(app, entra, {portal: "admin", person: ENTRA_PERSON})
    expect(result.authorizeUrl.searchParams.get("scope")).toBe("openid email profile")
    expect(result.authorizeUrl.searchParams.get("nonce")).toBeTruthy()
    expect(result.done.status).toBe(302)
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${result.sessionCookie}`}})
    expect(me.status).toBe(200)
    const body = (await me.json()) as {principal: {mentraUserId: string; emailVerified: boolean}}
    expect(body.principal.mentraUserId).toBe(phoneUser.mentraUserId)
    expect(body.principal.emailVerified).toBe(true)
    expect(entra.tokenRequests[0]?.auth).toBe("client_secret_post")
  })

  test("a provider email outside verifiedEmailDomains signs in without organization capabilities (L06)", async () => {
    const restore = applyEnv({CLOUD_CORE_ADMIN_EMAILS: "alex@mentra.glass"})
    try {
      const result = await portalSignIn(app, entra, {portal: "admin", person: {...ENTRA_PERSON, email: "alex@mentra.glass"}})
      expect(result.done.status).toBe(302)
      const me = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {cookie: `${ADMIN_COOKIE}=${result.sessionCookie}`}})
      expect(me.status).toBe(403)
    } finally {
      restore()
    }
  })

  describe("each creates no session (L04)", () => {
    async function refused(idTokenClaims: Record<string, unknown>, extra: Partial<typeof ENTRA_PERSON> & {idTokenAlg?: "HS256"} = {}) {
      const result = await portalSignIn(app, entra, {portal: "admin", person: {...ENTRA_PERSON, ...extra, idTokenClaims}})
      expect(result.done.status).toBe(400)
      expect(result.sessionCookie).toBeNull()
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

  test("the enterprise portal is not configured on a Private Cloud", async () => {
    const login = await app.request("https://portal.test/api/portal/auth/login")
    expect(login.status).toBe(503)
  })
})
