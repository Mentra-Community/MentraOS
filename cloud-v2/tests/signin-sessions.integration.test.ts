/**
 * @fileoverview Portal sessions, sign-in transactions and auth rate limits (L05,
 * Review Focus 2), against a local Mongo.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/signin-sessions.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {
  createPortalSession,
  readPortalSession,
  revokePortalSession,
  revokePortalSessionsForSource,
  revokePortalSessionsForUser,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_PREVIOUS_GRACE_MS,
  SESSION_ROTATE_AFTER_MS,
  type SessionIdentity,
} from "../packages/core/src/services/signin/browser-session.service"
import {
  consumeLoginTransaction,
  LOGIN_TRANSACTION_TTL_MS,
  startLoginTransaction,
} from "../packages/core/src/services/signin/login-transaction.service"
import {sha256Hex} from "../packages/core/src/services/signin/random"
import {consumeRateLimit} from "../packages/core/src/services/signin/rate-limit.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const databaseUrl = localTestMongoUrl("signin-sessions")
let verified = false
const savedIssuer = process.env.CLOUD_CORE_SUPABASE_ISSUER

const identity: SessionIdentity = {
  mentraUserId: "mu_session_1",
  tenantId: "mentra",
  sourceId: "mentra",
  subject: "supa-1",
  email: "a@b.co",
  emailVerified: true,
  authTime: new Date(),
}

const at = (base: Date, ms: number) => new Date(base.getTime() + ms)

beforeAll(async () => {
  process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://sessions.supabase.co/auth/v1"
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, BrowserSessionModel.db.name)
  verified = true
  await Promise.all([BrowserSessionModel.syncIndexes(), LoginTransactionModel.syncIndexes(), AuthRateLimitModel.syncIndexes()])
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, BrowserSessionModel.db.name)
    await BrowserSessionModel.db.dropDatabase()
  }
  await disconnectMongo()
  if (savedIssuer === undefined) delete process.env.CLOUD_CORE_SUPABASE_ISSUER
  else process.env.CLOUD_CORE_SUPABASE_ISSUER = savedIssuer
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, BrowserSessionModel.db.name)
  process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://sessions.supabase.co/auth/v1"
  await Promise.all([BrowserSessionModel.deleteMany({}), LoginTransactionModel.deleteMany({}), AuthRateLimitModel.deleteMany({})])
})

describe("portal sessions", () => {
  test("only hashes are stored (L05)", async () => {
    const {cookieValue} = await createPortalSession("admin", identity)
    expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = await BrowserSessionModel.find({}).lean()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(cookieValue)
    expect(rows[0]!.tokenHash).toBe(sha256Hex(cookieValue))
  })

  test("a session reads back its identity", async () => {
    const {cookieValue} = await createPortalSession("admin", identity)
    const read = await readPortalSession("admin", cookieValue)
    expect(read?.session).toMatchObject({mentraUserId: "mu_session_1", email: "a@b.co", emailVerified: true, tenantId: "mentra"})
    expect(read?.rotatedCookieValue).toBeNull()
  })

  test("an admin session does not read as a portal session, nor the reverse", async () => {
    const admin = await createPortalSession("admin", identity)
    const portal = await createPortalSession("portal", identity)
    expect(await readPortalSession("portal", admin.cookieValue)).toBeNull()
    expect(await readPortalSession("admin", portal.cookieValue)).toBeNull()
  })

  test("idle and absolute expiry", async () => {
    const start = new Date()
    const {cookieValue} = await createPortalSession("admin", identity, start)
    expect(await readPortalSession("admin", cookieValue, at(start, SESSION_IDLE_MS + 1))).toBeNull()

    // Used every few days, it still ends at the absolute lifetime.
    const second = await createPortalSession("admin", identity, start)
    await BrowserSessionModel.updateOne({tokenHash: sha256Hex(second.cookieValue)}, {$set: {lastSeenAt: at(start, SESSION_ABSOLUTE_MS - 1000), rotatedAt: at(start, SESSION_ABSOLUTE_MS - 1000)}})
    expect(await readPortalSession("admin", second.cookieValue, at(start, SESSION_ABSOLUTE_MS + 1))).toBeNull()
  })

  test("rotation after 24 h keeps the previous value for 60 s only", async () => {
    const start = new Date()
    const {cookieValue} = await createPortalSession("admin", identity, start)
    const rotationTime = at(start, SESSION_ROTATE_AFTER_MS + 1000)
    const rotated = await readPortalSession("admin", cookieValue, rotationTime)
    expect(rotated?.rotatedCookieValue).toBeTruthy()
    const next = rotated!.rotatedCookieValue!

    expect(await readPortalSession("admin", cookieValue, at(rotationTime, SESSION_PREVIOUS_GRACE_MS - 1000))).not.toBeNull()
    expect(await readPortalSession("admin", cookieValue, at(rotationTime, SESSION_PREVIOUS_GRACE_MS + 1000))).toBeNull()
    expect((await readPortalSession("admin", next, at(rotationTime, SESSION_PREVIOUS_GRACE_MS + 1000)))?.session.mentraUserId).toBe("mu_session_1")
  })

  test("three concurrent rotations leave one session record and one new value (Review Focus 2)", async () => {
    const start = new Date()
    const {cookieValue} = await createPortalSession("admin", identity, start)
    const rotationTime = at(start, SESSION_ROTATE_AFTER_MS + 1000)
    const results = await Promise.all([1, 2, 3].map(() => readPortalSession("admin", cookieValue, rotationTime)))
    expect(results.every(result => result !== null)).toBe(true)
    const newValues = results.map(result => result!.rotatedCookieValue).filter(Boolean)
    expect(newValues).toHaveLength(1)
    expect(await BrowserSessionModel.countDocuments({})).toBe(1)
    expect(await readPortalSession("admin", newValues[0]!, rotationTime)).not.toBeNull()
  })

  test("revocation refuses both the current and the previous value", async () => {
    const start = new Date()
    const {cookieValue} = await createPortalSession("admin", identity, start)
    const rotationTime = at(start, SESSION_ROTATE_AFTER_MS + 1000)
    const next = (await readPortalSession("admin", cookieValue, rotationTime))!.rotatedCookieValue!
    await revokePortalSession(cookieValue, "test")
    expect(await readPortalSession("admin", cookieValue, rotationTime)).toBeNull()
    expect(await readPortalSession("admin", next, rotationTime)).toBeNull()
  })

  test("revoking a user ends all of their sessions, and only theirs", async () => {
    const a = await createPortalSession("admin", identity)
    const b = await createPortalSession("portal", identity)
    const other = await createPortalSession("admin", {...identity, mentraUserId: "mu_other", subject: "supa-2"})
    expect(await revokePortalSessionsForUser("mu_session_1", "account_revocation")).toBe(2)
    expect(await readPortalSession("admin", a.cookieValue)).toBeNull()
    expect(await readPortalSession("portal", b.cookieValue)).toBeNull()
    expect(await readPortalSession("admin", other.cookieValue)).not.toBeNull()
  })

  test("revoking a source ends its sessions", async () => {
    const providerIdentity = {...identity, tenantId: "contoso", sourceId: "entra", mentraUserId: "mu_contoso"}
    process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify([
      {id: "entra", protocol: "oidc", providerKind: "microsoft-entra", tenantId: "contoso", issuer: "https://login.example/v2.0", jwksUrl: "https://login.example/keys", audience: "core"},
    ])
    try {
      const session = await createPortalSession("admin", providerIdentity)
      expect(await readPortalSession("admin", session.cookieValue)).not.toBeNull()
      expect(await revokePortalSessionsForSource("contoso", "source_disabled")).toBe(1)
      expect(await readPortalSession("admin", session.cookieValue)).toBeNull()
    } finally {
      delete process.env.CLOUD_CORE_OIDC_PROVIDERS
    }
  })

  test("removing the sign-in source from configuration ends its sessions on their next request", async () => {
    const {cookieValue} = await createPortalSession("admin", identity)
    expect(await readPortalSession("admin", cookieValue)).not.toBeNull()
    delete process.env.CLOUD_CORE_SUPABASE_ISSUER
    expect(await readPortalSession("admin", cookieValue)).toBeNull()
  })

  test("unknown, empty and oversized values read as no session", async () => {
    expect(await readPortalSession("admin", "unknown")).toBeNull()
    expect(await readPortalSession("admin", "")).toBeNull()
    expect(await readPortalSession("admin", "x".repeat(10_000))).toBeNull()
  })
})

describe("sign-in transactions", () => {
  test("four concurrent consumes of one transaction yield exactly one result", async () => {
    const {cookieValue, tx} = await startLoginTransaction("admin", "/reports")
    const results = await Promise.all([1, 2, 3, 4].map(() => consumeLoginTransaction(cookieValue, tx.state)))
    const winners = results.filter(Boolean)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({portal: "admin", returnTo: "/reports", state: tx.state, nonce: tx.nonce, pkceVerifier: tx.pkceVerifier})
  })

  test("a wrong state yields none", async () => {
    const {cookieValue} = await startLoginTransaction("admin", "/")
    expect(await consumeLoginTransaction(cookieValue, "wrong-state")).toBeNull()
  })

  test("an expired transaction yields none", async () => {
    const start = new Date()
    const {cookieValue, tx} = await startLoginTransaction("admin", "/", start)
    expect(await consumeLoginTransaction(cookieValue, tx.state, at(start, LOGIN_TRANSACTION_TTL_MS + 1))).toBeNull()
  })

  test("only the cookie hash is stored", async () => {
    const {cookieValue} = await startLoginTransaction("portal", "/")
    const row = await LoginTransactionModel.findOne({}).lean()
    expect(row?.txHash).toBe(sha256Hex(cookieValue))
    expect(JSON.stringify(row)).not.toContain(cookieValue)
  })
})

describe("auth rate limits", () => {
  test("allow exactly the limit across concurrent callers", async () => {
    const results = await Promise.all(Array.from({length: 30}, () => consumeRateLimit("login:ip:203.0.113.9", 20, 60)))
    expect(results.filter(Boolean)).toHaveLength(20)
  })

  test("a new window starts a new count", async () => {
    const now = Date.now()
    const windowStart = Math.floor(now / 60_000) * 60_000
    for (let i = 0; i < 2; i++) expect(await consumeRateLimit("k", 2, 60, windowStart)).toBe(true)
    expect(await consumeRateLimit("k", 2, 60, windowStart)).toBe(false)
    expect(await consumeRateLimit("k", 2, 60, windowStart + 60_000)).toBe(true)
  })
})
