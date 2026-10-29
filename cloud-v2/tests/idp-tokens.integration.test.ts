/**
 * @fileoverview The Supabase access token the sign-in page hands to Core's
 * sign-in server (L01, L07, L13): `verifySupabaseHandoffToken`.
 *
 * Core verifies it as the phone token exchange verifies Supabase tokens
 * (HS256 with the project's secret, or RS256 / ES256 with its key set; the
 * configured issuer; `aud` "authenticated"), refuses tokens Supabase's OAuth
 * server issued to a client, and refuses a session that started before the
 * person's revocation, even refreshed after it. Email verification comes from
 * the account's `email_confirmed_at`, never the token.
 *
 * The fake Supabase intercepts this process's `fetch`.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/idp-tokens.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  IdentityProviderUnavailableError,
  resetIdpTokenCaches,
  verifySupabaseHandoffToken,
} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {applyEnv} from "./support/signin-harness"

setDefaultTimeout(30_000)

const PROJECT = "https://idp-tokens.supabase.co"
const ISSUER = `${PROJECT}/auth/v1`
const JWKS = `${ISSUER}/.well-known/jwks.json`
const SECRET = "idp-tokens-test-secret-at-least-32-characters"

const databaseUrl = localTestMongoUrl("idp-tokens")
let verified = false
let supabase: FakeIdp
let restoreEnv: () => void = () => {}
const now = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await UserModel.syncIndexes()
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await UserModel.deleteMany({})
  restoreEnv = applyEnv({
    SUPABASE_URL: PROJECT,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_idp_tokens_test",
    CLOUD_CORE_SUPABASE_ISSUER: ISSUER,
    CLOUD_CORE_SUPABASE_JWKS_URL: JWKS,
    CLOUD_CORE_OIDC_PROVIDERS: undefined,
  })
  resetIdpTokenCaches()
  supabase = await installFakeIdp({issuer: ISSUER, jwksUrl: JWKS, hs256Secret: SECRET, projectUrl: PROJECT})
  supabase.registerUser({sub: "supa-1", email: "a@b.co", emailConfirmed: true})
})

afterEach(() => {
  supabase.restore()
  restoreEnv()
})

/** A token of the sign-in page's own Supabase session. */
function pageToken(claims: Record<string, unknown> = {}, alg: "HS256" | "ES256" | "RS256" = "HS256") {
  return supabase.mint({sub: "supa-1", aud: "authenticated", role: "authenticated", email: "a@b.co", ...claims}, {alg})
}

describe("the sign-in page's hand-off", () => {
  test("a Supabase session token resolves the Mentra App's Core user (L01)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
    const handoff = await verifySupabaseHandoffToken(await pageToken())
    expect(handoff).toMatchObject({mentraUserId: phoneUser.mentraUserId, subject: "supa-1", email: "a@b.co", emailVerified: true})
  })

  test("HS256, ES256 and RS256 tokens resolve the same Core user", async () => {
    const results = await Promise.all((["HS256", "ES256", "RS256"] as const).map(async alg => verifySupabaseHandoffToken(await pageToken({}, alg))))
    expect(new Set(results.map(result => result?.mentraUserId)).size).toBe(1)
    expect(results.every(Boolean)).toBe(true)
  })

  test("after a key rotation, a token signed with the new key succeeds after one key-set refresh", async () => {
    expect(await verifySupabaseHandoffToken(await pageToken({}, "ES256"))).not.toBeNull()
    await supabase.rotateKey()
    const fetchesBefore = supabase.jwksFetches
    expect(await verifySupabaseHandoffToken(await pageToken({}, "ES256"))).not.toBeNull()
    expect(supabase.jwksFetches).toBe(fetchesBefore + 1)
  })

  test("email verification comes from email_confirmed_at, read fresh, never user_metadata", async () => {
    supabase.registerUser({sub: "supa-1", email: "a@b.co", emailConfirmed: false})
    const unconfirmed = await verifySupabaseHandoffToken(await pageToken({user_metadata: {email_verified: true}, email_verified: true}))
    expect(unconfirmed?.emailVerified).toBe(false)
    supabase.registerUser({sub: "supa-1", email: "a@b.co", emailConfirmed: true})
    expect((await verifySupabaseHandoffToken(await pageToken()))?.emailVerified).toBe(true)
  })

  test("a session that started after webSignInsRevokedAt resolves", async () => {
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((now() - 60) * 1000)}})
    expect(await verifySupabaseHandoffToken(await pageToken({amr: [{method: "password", timestamp: now() - 10}]}))).not.toBeNull()
  })

  describe("each refused with null (L07)", () => {
    const refused = async (token: string | Promise<string>) => expect(await verifySupabaseHandoffToken(await token)).toBeNull()

    test("a session that started before webSignInsRevokedAt, even refreshed after it", async () => {
      const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
      await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((now() - 60) * 1000)}})
      await refused(pageToken({iat: now(), amr: [{method: "password", timestamp: now() - 600}]}))
    })
    test("a token Supabase's OAuth server issued to a client", () => refused(pageToken({client_id: "admin-portal"})))
    test("aud anon", () => refused(pageToken({aud: "anon"})))
    test("the wrong issuer", () => refused(pageToken({iss: "https://other.supabase.co/auth/v1"})))
    test("an HS256 token signed with another secret", async () => {
      const other = await installFakeIdp({issuer: ISSUER, jwksUrl: "https://unused.example/jwks", hs256Secret: "another-secret-of-sufficient-length-1234"})
      const token = await other.mint({sub: "supa-1", aud: "authenticated"}, {alg: "HS256"})
      other.restore()
      await refused(token)
    })
    test("an asymmetric token signed with a key the project never published", () =>
      refused(supabase.mint({sub: "supa-1", aud: "authenticated"}, {alg: "RS256", key: "attacker"})))
    test("an expired token", () => refused(pageToken({iat: now() - 7200, exp: now() - 3600})))
    test("iat more than 30 s in the future", () => refused(pageToken({iat: now() + 120, exp: now() + 3600})))
    test("a token without an amr timestamp", () => refused(pageToken({amr: [{method: "password"}]})))
    test("alg none", async () => {
      const [, payload] = (await pageToken()).split(".")
      await refused(`${Buffer.from(JSON.stringify({alg: "none", typ: "JWT"})).toString("base64url")}.${payload}.`)
    })
    test("a token whose jku points at another key set is checked only against the configured one", () =>
      refused(supabase.mint({sub: "supa-1", aud: "authenticated"}, {alg: "RS256", key: "attacker", header: {jku: "https://evil.example/jwks.json"}})))
    test("a deleted account", async () => {
      const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
      await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
      await refused(pageToken())
    })
    test("an account the directory no longer has", async () => refused(pageToken({sub: "supa-gone"})))
    test("garbage", () => refused("not-a-jwt"))
  })

  test("a key set outage fails closed with IdentityProviderUnavailableError", async () => {
    const token = await pageToken({}, "ES256")
    supabase.outage = true
    await expect(verifySupabaseHandoffToken(token)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  test("an account directory outage fails closed with IdentityProviderUnavailableError", async () => {
    const token = await pageToken()
    supabase.outage = true
    await expect(verifySupabaseHandoffToken(token)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  test("without Supabase configured, nothing is accepted", async () => {
    const token = await pageToken()
    delete process.env.CLOUD_CORE_SUPABASE_ISSUER
    expect(await verifySupabaseHandoffToken(token)).toBeNull()
  })
})
