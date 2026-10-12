/**
 * @fileoverview Identity-provider access tokens resolve to Core users (L01, L07).
 *
 * Runs `verifyIdpAccessToken` against fake Supabase and Entra providers (fetch
 * interception) and a local Mongo: the token checks, the mapping to the
 * phone's Core user, email trust, and refusal after a revocation, including a
 * Supabase token refreshed after it.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/idp-tokens.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  IdentityProviderUnavailableError,
  resetIdpTokenCaches,
  verifyIdpAccessToken,
} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const PROJECT = "https://idp-tokens.supabase.co"
const ISSUER = `${PROJECT}/auth/v1`
const JWKS = `${ISSUER}/.well-known/jwks.json`
const SECRET = "idp-tokens-test-secret-at-least-32-characters"
const ENTRA_ISSUER = "https://login.microsoftonline.com/contoso-tenant/v2.0"
const ENTRA_JWKS = "https://login.microsoftonline.com/contoso-tenant/discovery/v2.0/keys"

const ENV: Record<string, string> = {
  SUPABASE_URL: PROJECT,
  SUPABASE_JWT_SECRET: SECRET,
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_idp_tokens_test",
  CLOUD_CORE_SUPABASE_ISSUER: ISSUER,
  CLOUD_CORE_SUPABASE_JWKS_URL: JWKS,
  CLOUD_CORE_WEB_CLIENT_IDS: "admin-portal,console",
  CLOUD_CORE_OIDC_PROVIDERS: JSON.stringify([
    {
      id: "workforce",
      protocol: "oidc",
      providerKind: "microsoft-entra",
      tenantId: "contoso",
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      audience: "core-api",
      subjectClaim: "oid",
      directoryTenantClaim: "tid",
      expectedDirectoryTenantId: "contoso-tenant",
      requiredScopes: ["mentra.session"],
      allowedClientIds: ["mobile"],
      verifiedEmailDomains: ["contoso.com"],
    },
  ]),
}
const saved = Object.fromEntries(Object.keys(ENV).map(key => [key, process.env[key]]))

const databaseUrl = localTestMongoUrl("idp-tokens")
let verified = false
let supabase: FakeIdp
let entra: FakeIdp
const now = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  Object.assign(process.env, ENV)
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
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

beforeEach(async () => {
  resetIdpTokenCaches()
  supabase = await installFakeIdp({issuer: ISSUER, jwksUrl: JWKS, hs256Secret: SECRET, projectUrl: PROJECT})
  entra = await installFakeIdp({issuer: ENTRA_ISSUER, jwksUrl: ENTRA_JWKS, kind: "oidc"})
  supabase.registerUser({sub: "supa-1", email: "a@b.co", emailConfirmed: true})
})

afterEach(() => {
  entra.restore()
  supabase.restore()
})

function webToken(claims: Record<string, unknown> = {}, alg: "HS256" | "ES256" | "RS256" = "HS256") {
  return supabase.mint({sub: "supa-1", aud: "authenticated", client_id: "admin-portal", email: "a@b.co", ...claims}, {alg})
}

function entraToken(claims: Record<string, unknown> = {}) {
  return entra.mint({
    aud: "core-api",
    oid: "entra-oid-1",
    sub: "per-app-sub",
    tid: "contoso-tenant",
    scp: "mentra.session",
    azp: "mobile",
    email: "bob@contoso.com",
    ...claims,
  })
}

describe("Supabase access tokens", () => {
  test("a Supabase web token resolves the phone's Core user (L01)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
    const identity = await verifyIdpAccessToken(await webToken())
    expect(identity?.mentraUserId).toBe(phoneUser.mentraUserId)
    expect(identity?.tenantId).toBe("mentra")
    expect(identity?.clientId).toBe("admin-portal")
    expect(identity?.email).toBe("a@b.co")
    expect(identity?.emailVerified).toBe(true)
  })

  test("an HS256 and an ES256 access token resolve the same Core user", async () => {
    const legacy = await verifyIdpAccessToken(await webToken({}, "HS256"))
    const modern = await verifyIdpAccessToken(await webToken({}, "ES256"))
    expect(legacy?.mentraUserId).toBeTruthy()
    expect(modern?.mentraUserId).toBe(legacy!.mentraUserId)
  })

  test("after a key rotation, a token signed with the new key succeeds after one key-set refresh", async () => {
    expect(await verifyIdpAccessToken(await webToken({}, "ES256"))).not.toBeNull()
    const before = supabase.jwksFetches
    await supabase.rotateKey()
    expect(await verifyIdpAccessToken(await webToken({}, "ES256"))).not.toBeNull()
    expect(supabase.jwksFetches).toBe(before + 1)
  })

  test("email verification comes from email_confirmed_at, never user_metadata", async () => {
    supabase.registerUser({sub: "supa-unconfirmed", email: "c@d.co", emailConfirmed: false})
    const identity = await verifyIdpAccessToken(
      await webToken({sub: "supa-unconfirmed", email: "c@d.co", user_metadata: {email_verified: true}, email_verified: true}),
    )
    expect(identity?.email).toBe("c@d.co")
    expect(identity?.emailVerified).toBe(false)
  })

  test("the account lookup is cached for five minutes per person", async () => {
    await verifyIdpAccessToken(await webToken())
    await verifyIdpAccessToken(await webToken())
    expect(supabase.userLookups.filter(id => id === "supa-1")).toHaveLength(1)
  })

  test("a session that started after webSignInsRevokedAt resolves", async () => {
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((now() - 120) * 1000)}})
    const token = await webToken({amr: [{method: "oauth_provider/authorization_code", timestamp: now() - 60}]})
    expect((await verifyIdpAccessToken(token))?.mentraUserId).toBe(user.mentraUserId)
  })

  describe("each refused with null (L07)", () => {
    test("a client_id not on CLOUD_CORE_WEB_CLIENT_IDS (another environment's admin portal)", async () => {
      expect(await verifyIdpAccessToken(await webToken({client_id: "dev-admin-portal"}))).toBeNull()
    })

    test("no client_id (a Mentra App session token)", async () => {
      expect(await verifyIdpAccessToken(await webToken({client_id: undefined}))).toBeNull()
    })

    test("aud anon", async () => {
      expect(await verifyIdpAccessToken(await webToken({aud: "anon"}))).toBeNull()
    })

    test("aud equal to a client ID (an ID token)", async () => {
      expect(await verifyIdpAccessToken(await webToken({aud: "admin-portal"}, "ES256"))).toBeNull()
    })

    test("the wrong issuer", async () => {
      expect(await verifyIdpAccessToken(await webToken({iss: "https://other.supabase.co/auth/v1"}))).toBeNull()
    })

    test("an HS256 token signed with another secret", async () => {
      const other = await installFakeIdp({issuer: "https://unused.example", hs256Secret: "a-different-secret-of-sufficient-length"})
      try {
        const forged = await other.mint({iss: ISSUER, sub: "supa-1", aud: "authenticated", client_id: "admin-portal"})
        expect(await verifyIdpAccessToken(forged)).toBeNull()
      } finally {
        other.restore()
      }
    })

    test("an expired token", async () => {
      expect(await verifyIdpAccessToken(await webToken({iat: now() - 7200, exp: now() - 120}))).toBeNull()
    })

    test("iat more than 30 s in the future", async () => {
      expect(await verifyIdpAccessToken(await webToken({iat: now() + 120, exp: now() + 3600}))).toBeNull()
    })

    test("a token without an amr timestamp", async () => {
      expect(await verifyIdpAccessToken(await webToken({amr: [{method: "password"}]}))).toBeNull()
      expect(await verifyIdpAccessToken(await webToken({amr: undefined}))).toBeNull()
    })

    test("a session that started before webSignInsRevokedAt, even refreshed after it", async () => {
      const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-1"})
      const sessionStart = now() - 600
      await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((now() - 300) * 1000)}})
      const refreshed = await webToken({iat: now(), amr: [{method: "oauth_provider/authorization_code", timestamp: sessionStart}]})
      expect(await verifyIdpAccessToken(refreshed)).toBeNull()
    })

    test("alg none", async () => {
      const header = Buffer.from(JSON.stringify({alg: "none", typ: "JWT"})).toString("base64url")
      const payload = Buffer.from(
        JSON.stringify({iss: ISSUER, sub: "supa-1", aud: "authenticated", client_id: "admin-portal", iat: now(), exp: now() + 60}),
      ).toString("base64url")
      expect(await verifyIdpAccessToken(`${header}.${payload}.`)).toBeNull()
    })

    test("garbage", async () => {
      expect(await verifyIdpAccessToken("not-a-jwt")).toBeNull()
    })
  })

  test("a key set outage fails closed with IdentityProviderUnavailableError", async () => {
    supabase.outage = true
    await expect(verifyIdpAccessToken(await webToken({}, "ES256"))).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  test("an account directory outage fails closed with IdentityProviderUnavailableError", async () => {
    const token = await webToken()
    supabase.outage = true
    await expect(verifyIdpAccessToken(token)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })
})

describe("Private Cloud provider access tokens", () => {
  test("an Entra-shaped access token resolves (contoso, oid) and the phone's Core user", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "entra-oid-1"})
    const identity = await verifyIdpAccessToken(await entraToken())
    expect(identity?.tenantId).toBe("contoso")
    expect(identity?.subject).toBe("entra-oid-1")
    expect(identity?.mentraUserId).toBe(phoneUser.mentraUserId)
    expect(identity?.email).toBe("bob@contoso.com")
    expect(identity?.emailVerified).toBe(true)
  })

  test("an email outside verifiedEmailDomains is display data only", async () => {
    const identity = await verifyIdpAccessToken(await entraToken({email: "alex@mentra.glass"}))
    expect(identity?.email).toBe("alex@mentra.glass")
    expect(identity?.emailVerified).toBe(false)
  })

  test("a token issued before webSignInsRevokedAt is refused", async () => {
    const user = await findOrCreateUser({tenantId: "contoso", tenantUserId: "entra-oid-1"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date()}})
    expect(await verifyIdpAccessToken(await entraToken({iat: now() - 60}))).toBeNull()
    expect(await verifyIdpAccessToken(await entraToken({iat: now() + 2}))).not.toBeNull()
  })

  test("an ID token is not a bearer credential", async () => {
    expect(await verifyIdpAccessToken(await entraToken({nonce: "n-1", scp: undefined}))).toBeNull()
    expect(await verifyIdpAccessToken(await entraToken({nonce: "n-1"}))).toBeNull()
  })

  test("a missing scope, another client, or another directory is refused", async () => {
    expect(await verifyIdpAccessToken(await entraToken({scp: "other"}))).toBeNull()
    expect(await verifyIdpAccessToken(await entraToken({azp: "someone-else"}))).toBeNull()
    expect(await verifyIdpAccessToken(await entraToken({tid: "other-tenant"}))).toBeNull()
  })
})
