/**
 * @fileoverview Account-wide revocation reaches every web surface (L08,
 * Review Focus 5).
 *
 * For each of `revokeAllSessionsForUser`, `confirmAccountDeletion` and
 * `resetPassword`:
 *  - the person's admin portal session ends on its next request;
 *  - their sessions and grants at Core's sign-in server end: the sign-in site
 *    asks for credentials again, and the Developer Console's refresh fails;
 *  - a Core access token issued before the revocation is refused, while one
 *    from a later sign-in is accepted;
 *  - the sign-in page's hand-off refuses a Supabase session that started
 *    before the revocation, even refreshed after it;
 *  - Core ends every Supabase session of the person with one
 *    `POST /auth/v1/logout?scope=global` whose bearer it signed.
 *
 * GoTrue is the fake identity provider (fetch interception); Core's sign-in
 * server runs in-process, its issuer's origin routed to Core's app.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/signin-revocation.integration.test.ts`
 */

import crypto from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"
import * as client from "openid-client"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {OemModel} from "../packages/core/src/models/oem.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {SeenJtiModel} from "../packages/core/src/models/seen-jti.model"
import {SupportProfileModel} from "../packages/core/src/models/support-profile.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  confirmAccountDeletion,
  finishPendingAccountDeletions,
  login,
  otc,
  resetPassword,
  startAccountDeletionCompletion,
} from "../packages/core/src/services/account/account.service"
import {refreshSession, revokeAllSessionsForUser} from "../packages/core/src/services/session.service"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {verifyCoreAccessToken} from "../packages/core/src/services/oidc/core-access-token"
import {ensureOidcCollections} from "../packages/core/src/services/oidc/mongo-adapter"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches, verifySupabaseHandoffToken} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {Browser, CLIENT_SECRETS, CONSOLE_CALLBACK, finishInteraction, routeOriginsToApp, signedInPerson} from "./support/oidc-harness"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  coreAccessToken,
  HOSTED_ENV,
  OIDC_ISSUER,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

function keyPair() {
  const strip = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  return {
    priv: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    pub: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  }
}
const access = keyPair()
const account = keyPair()
const KEY_ENV = {
  MENTRA_JWT_PRIVATE_KEY: access.priv,
  MENTRA_JWT_PUBLIC_KEY: access.pub,
  MENTRA_ACCOUNT_JWT_PRIVATE_KEY: account.priv,
  MENTRA_ACCOUNT_JWT_PUBLIC_KEY: account.pub,
  REFRESH_TOKEN_PEPPER: "revocation-test-pepper",
}

const databaseUrl = localTestMongoUrl("signin-revocation")
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}
const SUB = "supa-revoked"
const PASSWORD = "old-password-1"
const nowSec = () => Math.floor(Date.now() / 1000)
const MODELS = [UserModel, BrowserSessionModel, RefreshTokenModel, AccountCodeModel, OemModel, SeenJtiModel, SupportProfileModel, SigninIdentityModel]

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([...MODELS.map(model => model.syncIndexes()), ensureOidcCollections()])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
  restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
})

let restoreFetch: () => void = () => {}

afterAll(async () => {
  restoreFetch()
  await stopOidcBridge()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({...HOSTED_ENV, ...KEY_ENV})
  resetCoreKeyCaches()
  resetIdpTokenCaches()
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  // The account module's own OEM row (startup migration ensureMentraAccountOem).
  await OemModel.create({
    tenantId: "mentra",
    displayName: "Mentra",
    publicKeyMode: "static",
    publicKey: `-----BEGIN PUBLIC KEY-----\n${account.pub}\n-----END PUBLIC KEY-----`,
  })
  idp = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
  idp.registerUser({sub: SUB, email: ADMIN_EMAIL, emailConfirmed: true, password: PASSWORD})
})

afterEach(() => {
  idp.restore()
  restoreEnv()
  resetCoreKeyCaches()
})

/** The Developer Console as a client of Core's sign-in server. */
async function consoleClient(): Promise<client.Configuration> {
  const secret = CLIENT_SECRETS.CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET
  return client.discovery(new URL(OIDC_ISSUER), "console", {client_secret: secret, id_token_signed_response_alg: "EdDSA"}, client.ClientSecretPost(secret))
}

/** An authorization request for the Console in `browser`; where the provider sends it first. */
async function authorizeConsole(browser: Browser) {
  const config = await consoleClient()
  const verifier = client.randomPKCECodeVerifier()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: CONSOLE_CALLBACK,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: "s",
  })
  const step = await browser.follow(url.href, location => location.pathname.startsWith("/interaction/") || location.href.startsWith(CONSOLE_CALLBACK))
  if (!("stoppedAt" in step)) throw new Error("no redirect")
  return {config, verifier, stoppedAt: step.stoppedAt}
}

/**
 * A person signed in everywhere before the revocation: an admin portal session,
 * a session at Core's sign-in server, the Developer Console's grant (access and
 * refresh tokens), and a live Supabase session (the Mentra App's).
 */
async function signedInEverywhere() {
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: SUB})
  await signedInPerson({subject: SUB, email: ADMIN_EMAIL, emailVerified: true})
  const {cookieValue} = await createPortalSession("admin", {
    mentraUserId: user.mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: SUB,
    email: ADMIN_EMAIL,
    emailVerified: true,
    authTime: new Date(),
  })
  const sessionStart = nowSec() - 600
  const appSession = idp.startSession(SUB, null, sessionStart)
  const browser = new Browser(app)
  const first = await authorizeConsole(browser)
  const resume = await finishInteraction(first.stoppedAt, user.mentraUserId, {consent: false})
  const back = await browser.follow(resume.href, location => location.href.startsWith(CONSOLE_CALLBACK))
  if (!("stoppedAt" in back)) throw new Error("no code")
  const tokens = await client.authorizationCodeGrant(first.config, back.stoppedAt, {pkceCodeVerifier: first.verifier, expectedState: "s"})
  expect(tokens.refresh_token).toBeTruthy()
  expect((await adminMe(`Bearer ${tokens.access_token}`)).status).toBe(200)
  expect((await adminMe(undefined, cookieValue)).status).toBe(200)
  return {user, cookieValue, sessionStart, appSession, browser, config: first.config, tokens}
}

/** The sign-in page's hand-off of a Supabase session that started at `sessionStart`. */
async function handoffToken(sessionStart: number, iat = nowSec()) {
  return idp.mint({
    sub: SUB,
    aud: "authenticated",
    email: ADMIN_EMAIL,
    session_id: "page-session",
    iat,
    amr: [{method: "password", timestamp: sessionStart}],
  })
}

function adminMe(authorization?: string, cookie?: string) {
  const headers: Record<string, string> = {}
  if (authorization) headers.authorization = authorization
  if (cookie) headers.cookie = `${ADMIN_COOKIE}=${cookie}`
  return app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers})
}

async function expectRevokedEverywhere(before: Awaited<ReturnType<typeof signedInEverywhere>>) {
  // The portal session's next request is refused.
  expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
  // The Console's Core access token from before the revocation is refused; one from a later sign-in is accepted.
  expect(await verifyCoreAccessToken(before.tokens.access_token)).toBeNull()
  expect((await adminMe(`Bearer ${before.tokens.access_token}`)).status).toBe(401)
  expect((await adminMe(`Bearer ${await coreAccessToken({sub: SUB, email: ADMIN_EMAIL, iat: nowSec() + 2})}`)).status).toBe(200)
  // The Console's refresh fails: the grant has ended.
  await expect(client.refreshTokenGrant(before.config, before.tokens.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
  // The sign-in site asks for credentials again.
  expect((await authorizeConsole(before.browser)).stoppedAt.pathname.startsWith("/interaction/")).toBe(true)
  // The hand-off refuses a Supabase session that started before the revocation, also refreshed after it.
  resetIdpTokenCaches()
  expect(await verifySupabaseHandoffToken(await handoffToken(before.sessionStart))).toBeNull()
  expect(await verifySupabaseHandoffToken(await handoffToken(before.sessionStart, nowSec() + 5))).toBeNull()
  // Every Supabase session of the person has ended.
  expect(before.appSession.endedAt).not.toBeNull()
}

/** Make the account directory's admin API answer 503 for `methods` on this person, until the returned function runs. */
function blockDirectory(methods: string[]): () => void {
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url.startsWith(`${SUPABASE_PROJECT}/auth/v1/admin/users/${SUB}`) && methods.includes(request.method)) {
      return new Response(JSON.stringify({error: "unavailable"}), {status: 503})
    }
    return inner(input as RequestInfo, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = inner
  }
}

async function accountInDirectory(): Promise<boolean> {
  const response = await fetch(`${SUPABASE_PROJECT}/auth/v1/admin/users/${SUB}`, {
    headers: {apikey: "sb_secret_signin_test", authorization: "Bearer sb_secret_signin_test"},
  })
  return response.status === 200
}

async function expectOneGlobalLogout() {
  const calls = idp.logoutCalls.filter(call => call.scope === "global")
  expect(calls).toHaveLength(1)
  const call = calls[0]!
  expect(call.status).toBe(204)
  expect(call.apikey).toBe("sb_secret_signin_test")
  expect(call.sub).toBe(SUB)
  expect(call.sessionId).toBeNull()
  expect(call.claims?.session_id).toBeUndefined()
  expect((call.claims?.exp as number) - (call.claims?.iat as number)).toBe(60)
  expect(call.claims?.aud).toBe("authenticated")
  expect(call.claims?.role).toBe("authenticated")
}

describe("revokeAllSessionsForUser", () => {
  test("ends portal sessions, refuses earlier sign-ins and ends every Supabase session", async () => {
    const before = await signedInEverywhere()
    await revokeAllSessionsForUser({mentraUserId: before.user.mentraUserId})
    await expectOneGlobalLogout()
    await expectRevokedEverywhere(before)
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.webSignInsRevokedAt).toBeInstanceOf(Date)
  })

  test("the global logout token verifies with SUPABASE_JWT_SECRET", async () => {
    const before = await signedInEverywhere()
    let captured = ""
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes("/logout?scope=global")) captured = request.headers.get("authorization")?.slice(7) ?? ""
      return inner(input as RequestInfo, init)
    }) as typeof fetch
    try {
      await revokeAllSessionsForUser({mentraUserId: before.user.mentraUserId})
    } finally {
      globalThis.fetch = inner
    }
    const {payload} = await jose.jwtVerify(captured, new TextEncoder().encode(SUPABASE_SECRET), {algorithms: ["HS256"]})
    expect(payload.sub).toBe(SUB)
    expect(payload.exp! - payload.iat!).toBe(60)
    expect(payload.session_id).toBeUndefined()
  })
})

describe("confirmAccountDeletion", () => {
  test("revokes every web surface and deletes the account", async () => {
    const before = await signedInEverywhere()
    const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
    await confirmAccountDeletion(before.user.mentraUserId, SUB, code)
    await expectOneGlobalLogout()
    expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
    expect((await adminMe(`Bearer ${before.tokens.access_token}`)).status).toBe(401)
    await expect(client.refreshTokenGrant(before.config, before.tokens.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
    expect(before.appSession.endedAt).not.toBeNull()
    // How the person signed in to Core's sign-in server, email included, is gone with the account.
    expect(await SigninIdentityModel.countDocuments({mentraUserId: before.user.mentraUserId})).toBe(0)
  })

  test("with the account directory down, a confirmed deletion is accepted and the account is no principal; Core finishes it later", async () => {
    const before = await signedInEverywhere()
    const phone = await login(ADMIN_EMAIL, PASSWORD)
    // The account directory cannot answer about this account.
    const restore = blockDirectory(["GET", "DELETE"])
    try {
      const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
      // Accepted: the person never has to come back to finish it.
      await confirmAccountDeletion(before.user.mentraUserId, SUB, code)
    } finally {
      restore()
    }
    // The directory still has the account and the deletion is not complete, but Core treats the account as deleted.
    expect(await accountInDirectory()).toBe(true)
    expect(await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean()).toMatchObject({
      supportTelemetryDeletedAt: expect.any(Date),
      accountDeletionCompletedAt: null,
    })

    // Signing in again, through Core's account login (the phone's token exchange), is refused.
    await expect(login(ADMIN_EMAIL, PASSWORD)).rejects.toMatchObject({code: "invalid_grant"})
    // So is refreshing the phone session it had (deletion also revoked it).
    await expect(refreshSession({refreshToken: phone.refresh_token})).rejects.toMatchObject({code: "invalid_grant"})
    // A Supabase sign-in that started after the revocation is refused at the hand-off too.
    resetIdpTokenCaches()
    const later = nowSec() + 2
    expect(await verifySupabaseHandoffToken(await handoffToken(later, later))).toBeNull()
    // As is a portal session, should one be created now.
    const {cookieValue} = await createPortalSession("admin", {
      mentraUserId: before.user.mentraUserId,
      tenantId: "mentra",
      sourceId: "mentra",
      subject: SUB,
      email: ADMIN_EMAIL,
      emailVerified: true,
      authTime: new Date(),
    })
    expect((await adminMe(undefined, cookieValue)).status).toBe(401)

    // With the directory answering again, Core's sweep finishes the deletion; a second sweep finds nothing.
    expect(await finishPendingAccountDeletions()).toEqual({completed: [before.user.mentraUserId], failed: []})
    expect(await accountInDirectory()).toBe(false)
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.accountDeletionCompletedAt).toBeInstanceOf(Date)
    expect(await finishPendingAccountDeletions()).toEqual({completed: [], failed: []})
  })

  test("a deletion interrupted right after its confirmation (a crash) is finished by Core's sweep, and the tombstone never lifts", async () => {
    const before = await signedInEverywhere()
    const deletedAt = new Date()
    // All that a confirmation that crashed at once leaves behind: the tombstone.
    await UserModel.updateOne({mentraUserId: before.user.mentraUserId}, {$set: {supportTelemetryDeletedAt: deletedAt}})
    expect(await BrowserSessionModel.countDocuments({mentraUserId: before.user.mentraUserId, revokedAt: null})).toBe(1)

    // A failing step leaves it pending, and still deleted.
    const restore = blockDirectory(["DELETE"])
    try {
      expect(await finishPendingAccountDeletions()).toEqual({completed: [], failed: [before.user.mentraUserId]})
    } finally {
      restore()
    }
    expect(await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean()).toMatchObject({
      supportTelemetryDeletedAt: deletedAt,
      accountDeletionCompletedAt: null,
    })
    await expect(login(ADMIN_EMAIL, PASSWORD)).rejects.toMatchObject({code: "invalid_grant"})

    expect(await finishPendingAccountDeletions()).toEqual({completed: [before.user.mentraUserId], failed: []})
    expect(await BrowserSessionModel.countDocuments({mentraUserId: before.user.mentraUserId, revokedAt: null})).toBe(0)
    expect(await accountInDirectory()).toBe(false)
    expect(await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean()).toMatchObject({
      supportTelemetryDeletedAt: deletedAt,
      accountDeletionCompletedAt: expect.any(Date),
    })
  })

  test("Core runs the sweep at start and on an interval, and stops it cleanly", async () => {
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: SUB})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})

    const stop = startAccountDeletionCompletion(60_000)
    await stop()

    expect((await UserModel.findOne({mentraUserId: user.mentraUserId}).lean())?.accountDeletionCompletedAt).toBeInstanceOf(Date)
    expect(await accountInDirectory()).toBe(false)
  })

  test("a failing Supabase logout still completes account deletion", async () => {
    const before = await signedInEverywhere()
    idp.failLogout = true
    const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
    await confirmAccountDeletion(before.user.mentraUserId, SUB, code)
    expect(idp.logoutCalls.filter(call => call.scope === "global").map(call => call.status)).toEqual([500])
    expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.supportTelemetryDeletedAt).toBeInstanceOf(Date)
  })
})

describe("resetPassword", () => {
  test("revokes every web surface and signs the phone in fresh", async () => {
    const before = await signedInEverywhere()
    const code = await otc.issueEmailCode({
      purpose: "password_reset",
      subject: ADMIN_EMAIL,
      ttlSec: 900,
      payload: {userId: SUB},
    })
    const tokens = await resetPassword(ADMIN_EMAIL, code, "new-password-2")
    expect(tokens.access_token).toBeTruthy()
    await expectOneGlobalLogout()
    await expectRevokedEverywhere(before)
  })

  test("from the sign-in page, revokes every web surface and mints no phone session", async () => {
    const before = await signedInEverywhere()
    const code = await otc.issueEmailCode({purpose: "password_reset", subject: ADMIN_EMAIL, ttlSec: 900, payload: {userId: SUB}})
    const response = await app.request(`${OIDC_ISSUER}/api/account/password/reset`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({email: ADMIN_EMAIL, code, newPassword: "new-password-3", signIn: false}),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({status: "password_updated"})
    expect(await RefreshTokenModel.countDocuments({mentraUserId: before.user.mentraUserId})).toBe(0)
    await expectOneGlobalLogout()
    await expectRevokedEverywhere(before)
  })
})

describe("configuration", () => {
  test("removing the sign-in source from configuration ends its people's portal sessions, tokens and refreshes on their next request", async () => {
    const before = await signedInEverywhere()
    delete process.env.CLOUD_CORE_SUPABASE_ISSUER
    expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
    expect((await adminMe(`Bearer ${before.tokens.access_token}`)).status).toBe(401)
    await expect(client.refreshTokenGrant(before.config, before.tokens.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
  })
})
