/**
 * @fileoverview Account-wide revocation reaches every web surface (L08,
 * Review Focus 5).
 *
 * For each of `revokeAllSessionsForUser`, `confirmAccountDeletion` and
 * `resetPassword`: the person's admin portal session ends on its next request;
 * a Supabase token from a session that started before the revocation is
 * refused, even refreshed after it, while one from a later session is
 * accepted; and Core ends every Supabase session of the person with one
 * `POST /auth/v1/logout?scope=global` whose bearer it signed.
 *
 * GoTrue is the fake identity provider (fetch interception).
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/signin-revocation.integration.test.ts`
 */

import crypto from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {OemModel} from "../packages/core/src/models/oem.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {SeenJtiModel} from "../packages/core/src/models/seen-jti.model"
import {SupportProfileModel} from "../packages/core/src/models/support-profile.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {confirmAccountDeletion, login, otc, resetPassword} from "../packages/core/src/services/account/account.service"
import {refreshSession, revokeAllSessionsForUser} from "../packages/core/src/services/session.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
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
const MODELS = [UserModel, BrowserSessionModel, RefreshTokenModel, AccountCodeModel, OemModel, SeenJtiModel, SupportProfileModel]

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.syncIndexes()))
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

/** A person signed in before the revocation: a portal session, a Console token, and live Supabase sessions. */
async function signedInEverywhere() {
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: SUB})
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
  const signInPage = idp.startSession(SUB, null, sessionStart)
  const console = idp.startSession(SUB, "console-client", sessionStart)
  const consoleToken = await bearerToken(sessionStart, console.sessionId)
  expect((await adminMe(`Bearer ${consoleToken}`)).status).toBe(200)
  expect((await adminMe(undefined, cookieValue)).status).toBe(200)
  return {user, cookieValue, sessionStart, signInPage, console}
}

function bearerToken(sessionStart: number, sessionId: string, iat = nowSec()) {
  return idp.mint({
    sub: SUB,
    aud: "authenticated",
    client_id: "console-client",
    email: ADMIN_EMAIL,
    session_id: sessionId,
    iat,
    amr: [{method: "oauth_provider/authorization_code", timestamp: sessionStart}],
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
  // A token from a session that started before the revocation is refused, also one refreshed after it.
  resetIdpTokenCaches()
  expect((await adminMe(`Bearer ${await bearerToken(before.sessionStart, before.console.sessionId)}`)).status).toBe(401)
  expect((await adminMe(`Bearer ${await bearerToken(before.sessionStart, before.console.sessionId, nowSec() + 5)}`)).status).toBe(401)
  // A session that started after the revocation is accepted.
  const later = nowSec() + 2
  expect((await adminMe(`Bearer ${await bearerToken(later, "later-session", later)}`)).status).toBe(200)
  // Every Supabase session of the person has ended, the sign-in page's included.
  expect(before.signInPage.endedAt).not.toBeNull()
  expect(before.console.endedAt).not.toBeNull()
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
    resetIdpTokenCaches()
    expect((await adminMe(`Bearer ${await bearerToken(before.sessionStart, before.console.sessionId)}`)).status).toBe(401)
    expect(before.signInPage.endedAt).not.toBeNull()
  })

  test("from the moment deletion starts the account is no principal: sign-in, exchange, refresh, sessions and tokens", async () => {
    const before = await signedInEverywhere()
    const phone = await login(ADMIN_EMAIL, PASSWORD)
    // Deletion stalls after its first step: the account directory cannot answer about this account.
    const restore = blockDirectory(["GET", "DELETE"])
    try {
      const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
      await expect(confirmAccountDeletion(before.user.mentraUserId, SUB, code)).rejects.toThrow()
    } finally {
      restore()
    }
    // The directory still has the account, but Core treats it as deleted.
    expect(await accountInDirectory()).toBe(true)
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.supportTelemetryDeletedAt).toBeInstanceOf(Date)

    // Signing in again, through Core's account login (the phone's token exchange), is refused.
    await expect(login(ADMIN_EMAIL, PASSWORD)).rejects.toMatchObject({code: "invalid_grant"})
    // So is refreshing the phone session it had (deletion also revoked it).
    await expect(refreshSession({refreshToken: phone.refresh_token})).rejects.toMatchObject({code: "invalid_grant"})
    // A Supabase sign-in that started after the revocation is refused too.
    resetIdpTokenCaches()
    const later = nowSec() + 2
    expect((await adminMe(`Bearer ${await bearerToken(later, "later-session", later)}`)).status).toBe(401)
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

    // Asked again with the directory answering, the deletion completes.
    const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
    await confirmAccountDeletion(before.user.mentraUserId, SUB, code)
    expect(await accountInDirectory()).toBe(false)
  })

  test("a deletion that fails while the directory still has the account lifts the tombstone, so the person can sign in and ask again", async () => {
    const before = await signedInEverywhere()
    const restore = blockDirectory(["DELETE"])
    try {
      const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
      await expect(confirmAccountDeletion(before.user.mentraUserId, SUB, code)).rejects.toThrow()
    } finally {
      restore()
    }
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.supportTelemetryDeletedAt).toBeNull()
    // Everything signed in before is still revoked, but the person can sign in again.
    expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
    const fresh = await login(ADMIN_EMAIL, PASSWORD)
    expect(fresh.access_token).toBeTruthy()

    const code = await otc.issueEmailCode({purpose: "account_deletion", subject: SUB, ttlSec: 900})
    await confirmAccountDeletion(before.user.mentraUserId, SUB, code)
    expect(await accountInDirectory()).toBe(false)
    expect((await UserModel.findOne({mentraUserId: before.user.mentraUserId}).lean())?.supportTelemetryDeletedAt).toBeInstanceOf(Date)
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
})

describe("configuration", () => {
  test("removing the sign-in source from configuration ends its portal sessions on their next request", async () => {
    const before = await signedInEverywhere()
    delete process.env.CLOUD_CORE_SUPABASE_ISSUER
    expect((await adminMe(undefined, before.cookieValue)).status).toBe(401)
  })
})
