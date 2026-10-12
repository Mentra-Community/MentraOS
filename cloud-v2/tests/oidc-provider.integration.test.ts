/**
 * @fileoverview Core's sign-in server, its OpenID Connect provider (L04, L05,
 * L07, L14, Review Focus 2 and 4).
 *
 * Runs Core's real app in-process. The provider runs on its own listener
 * behind Core's relay, exactly as in production; the test's `fetch` sends the
 * issuer's origin to Core's app, as the sign-in site's relay does.
 * openid-client 6.8.8 is the relying party. Sign-in steps are completed
 * through the provider's Interaction model (the sign-in page's hand-off is
 * covered by oidc-interaction).
 *
 * Also pins the separation between token types that share Core's signing key:
 * the provider's access and ID tokens are refused wherever Core accepts phone,
 * runtime, account or miniapp tokens, and those are refused as Core access
 * tokens.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/oidc-provider.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as jose from "jose"
import * as client from "openid-client"

import {createMentraAuth} from "../packages/auth/src/index"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {oidcBridge, stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {verifyCoreAccessToken} from "../packages/core/src/services/oidc/core-access-token"
import {ensureOidcCollections, oidcCollectionName} from "../packages/core/src/services/oidc/mongo-adapter"
import {
  issueMiniappToken,
  issueRuntimeToken,
  mintAccountSubjectToken,
  verifyAccessToken,
} from "../packages/core/src/services/session.service"
import {verifyRuntimeToken} from "../packages/shared/src/auth"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {applyEnv} from "./support/signin-harness"
import {
  ADMIN_CALLBACK,
  ADMIN_ORIGIN,
  Browser,
  CLIENT_SECRETS,
  CONSOLE_CALLBACK,
  coreKeyEnv,
  finishInteraction,
  OIDC_ISSUER,
  PORTAL_ORIGIN,
  providerEnv,
  routeOriginsToApp,
  signedInPerson,
} from "./support/oidc-harness"

setDefaultTimeout(30_000)

const databaseUrl = localTestMongoUrl("oidc-provider")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
const keys = coreKeyEnv()

beforeAll(async () => {
  restoreEnv = applyEnv({
    ...keys,
    ...providerEnv(),
    CLOUD_CORE_SUPABASE_ISSUER: "https://signin.supabase.co/auth/v1",
    CLOUD_CORE_OIDC_PROVIDERS: undefined,
    REFRESH_TOKEN_PEPPER: "oidc-provider-pepper",
  })
  resetCoreKeyCaches()
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([UserModel.syncIndexes(), SigninIdentityModel.syncIndexes(), ensureOidcCollections()])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
  restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
})

afterAll(async () => {
  restoreFetch()
  await stopOidcBridge()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
  restoreEnv()
  resetCoreKeyCaches()
})

let restoreCase: () => void = () => {}
beforeEach(() => {
  restoreCase = () => {}
})
afterEach(() => restoreCase())

async function rp(clientId: string, secretEnv?: keyof typeof CLIENT_SECRETS): Promise<client.Configuration> {
  const secret = secretEnv ? CLIENT_SECRETS[secretEnv] : undefined
  return client.discovery(
    new URL(OIDC_ISSUER),
    clientId,
    secret ? {client_secret: secret, id_token_signed_response_alg: "EdDSA"} : {id_token_signed_response_alg: "EdDSA"},
    secret ? client.ClientSecretPost(secret) : client.None(),
  )
}

interface FlowResult {
  config: client.Configuration
  callback: URL
  verifier: string
  state: string
  nonce: string
  browser: Browser
}

/** Run the authorization request until the provider redirects to the client, signing in as `mentraUserId` when asked. */
async function authorize(opts: {
  clientId?: string
  secretEnv?: keyof typeof CLIENT_SECRETS
  redirectUri?: string
  mentraUserId: string
  browser?: Browser
}): Promise<FlowResult> {
  const clientId = opts.clientId ?? "admin-portal"
  const redirectUri = opts.redirectUri ?? ADMIN_CALLBACK
  const config = await rp(clientId, opts.secretEnv ?? "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
  const verifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  })
  const browser = opts.browser ?? new Browser(app)
  const leftForClient = (location: URL) => location.href.startsWith(redirectUri)
  let step = await browser.follow(url.href, location => leftForClient(location) || location.pathname.startsWith("/interaction/"))
  if ("stoppedAt" in step && !leftForClient(step.stoppedAt)) {
    const resume = await finishInteraction(step.stoppedAt, opts.mentraUserId)
    step = await browser.follow(resume.href, leftForClient)
  }
  if (!("stoppedAt" in step)) throw new Error(`no redirect to the client: ${step.page.status}`)
  return {config, callback: step.stoppedAt, verifier, state, nonce, browser}
}

async function redeem(flow: FlowResult) {
  return client.authorizationCodeGrant(flow.config, flow.callback, {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  })
}

async function signWithCoreKey(header: jose.JWTHeaderParameters, claims: jose.JWTPayload, expiresIn = "1h"): Promise<string> {
  const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${keys.MENTRA_JWT_PRIVATE_KEY}\n-----END PRIVATE KEY-----`, "EdDSA")
  return new jose.SignJWT(claims).setProtectedHeader(header).setIssuedAt().setExpirationTime(expiresIn).sign(key)
}

let personCounter = 0
async function person(overrides: {email?: string} = {}) {
  personCounter++
  return signedInPerson({subject: `supa-${personCounter}`, email: overrides.email ?? `person${personCounter}@example.com`, emailVerified: true, name: `Person ${personCounter}`})
}

describe("discovery and keys", () => {
  test("discovery lists the endpoints on the issuer and Core's key set, and no registration", async () => {
    const response = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${OIDC_ISSUER}/oidc/auth`,
      token_endpoint: `${OIDC_ISSUER}/oidc/token`,
      userinfo_endpoint: `${OIDC_ISSUER}/oidc/me`,
      revocation_endpoint: `${OIDC_ISSUER}/oidc/token/revocation`,
      end_session_endpoint: `${OIDC_ISSUER}/oidc/session/end`,
      jwks_uri: `${OIDC_ISSUER}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["EdDSA"],
    })
    expect(metadata.registration_endpoint).toBeUndefined()
    expect(metadata.device_authorization_endpoint).toBeUndefined()
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"])
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["client_secret_post", "none"])
  })

  test("jwks_uri is Core's key set, with the sign-in server's key", async () => {
    const jwks = (await (await fetch(`${OIDC_ISSUER}/.well-known/jwks.json`)).json()) as {keys: jose.JWK[]}
    const kids = jwks.keys.map(key => key.kid)
    expect(kids).toContain("mentra-oidc-1")
    expect(kids).toContain("mentra-miniapp-1")
    expect(jwks.keys.every(key => key.d === undefined)).toBe(true)
  })

  test("forwarding headers never change the issuer or redirects", async () => {
    const headers = {"x-forwarded-host": "evil.test", "x-forwarded-proto": "http", forwarded: "host=evil.test", "x-mentra-public-origin": "https://evil.test"}
    const discovery = (await (await app.request(`${OIDC_ISSUER}/.well-known/openid-configuration`, {headers})).json()) as {issuer: string; token_endpoint: string}
    expect(discovery.issuer).toBe(OIDC_ISSUER)
    expect(discovery.token_endpoint).toBe(`${OIDC_ISSUER}/oidc/token`)
  })

  test("the provider's own listener answers only Core's relay", async () => {
    const bridge = (await oidcBridge())!
    const direct = await fetch(`${bridge.origin}/.well-known/openid-configuration`)
    expect(direct.status).toBe(404)
  })
})

describe("the authorization code flow (L04)", () => {
  test("S256 PKCE, client_secret_post and EdDSA tokens: the ID token names the person and the access token is for Core's API", async () => {
    const {mentraUserId} = await person({email: "ada@example.com"})
    const flow = await authorize({mentraUserId})
    expect(flow.callback.searchParams.get("iss")).toBe(OIDC_ISSUER)
    const tokens = await redeem(flow)
    const claims = tokens.claims()!
    expect(claims).toMatchObject({iss: OIDC_ISSUER, sub: mentraUserId, aud: "admin-portal", email: "ada@example.com", email_verified: true})
    expect(jose.decodeProtectedHeader(tokens.id_token!)).toMatchObject({alg: "EdDSA", kid: "mentra-oidc-1"})
    expect(tokens.refresh_token).toBeUndefined()

    expect(jose.decodeProtectedHeader(tokens.access_token)).toMatchObject({alg: "EdDSA", kid: "mentra-oidc-1", typ: "at+jwt"})
    expect(jose.decodeJwt(tokens.access_token)).toMatchObject({iss: OIDC_ISSUER, aud: "urn:mentra:core", client_id: "admin-portal", sub: mentraUserId})
    expect(await verifyCoreAccessToken(tokens.access_token)).toMatchObject({mentraUserId, clientId: "admin-portal", email: "ada@example.com"})
  })

  test("a request without PKCE, or with the plain method, gets no code", async () => {
    const config = await rp("admin-portal", "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
    for (const extra of [{}, {code_challenge: "a".repeat(43), code_challenge_method: "plain"}]) {
      const url = client.buildAuthorizationUrl(config, {redirect_uri: ADMIN_CALLBACK, scope: "openid", state: "s", ...extra})
      const response = await new Browser(app).request(url)
      const location = new URL(response.headers.get("location")!)
      expect(location.searchParams.get("error")).toBe("invalid_request")
      expect(location.searchParams.get("code")).toBeNull()
    }
  })

  test("an unregistered redirect URI or an unknown client gets a fixed error page and no redirect", async () => {
    const config = await rp("admin-portal", "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
    const challenge = await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier())
    const bad = [
      client.buildAuthorizationUrl(config, {redirect_uri: `${ADMIN_CALLBACK}/`, scope: "openid", code_challenge: challenge, code_challenge_method: "S256"}),
      client.buildAuthorizationUrl(config, {redirect_uri: "https://evil.test/cb", scope: "openid", code_challenge: challenge, code_challenge_method: "S256"}),
    ]
    const unknown = new URL(bad[0]!)
    unknown.searchParams.set("client_id", "not-registered")
    unknown.searchParams.set("redirect_uri", "https://evil.test/<script>")
    for (const url of [...bad, unknown]) {
      const response = await new Browser(app).request(url)
      expect(response.status).toBe(400)
      expect(response.headers.get("location")).toBeNull()
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      const html = await response.text()
      expect(html).not.toContain("evil.test")
      expect(html).not.toContain("not-registered")
    }
  })

  test("dynamic client registration is refused (L14)", async () => {
    const response = await fetch(`${OIDC_ISSUER}/oidc/reg`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({redirect_uris: ["https://evil.test/cb"]}),
    })
    expect(response.status).toBe(404)
  })

  test("two concurrent redemptions of one code: exactly one succeeds, and a replay fails (Review Focus 2)", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({mentraUserId})
    const results = await Promise.allSettled([redeem(flow), redeem(flow)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    await expect(redeem(flow)).rejects.toMatchObject({error: "invalid_grant"})
  })
})

describe("refresh tokens (L14)", () => {
  test("refresh tokens rotate; reusing a spent one fails and ends the grant", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({clientId: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUri: CONSOLE_CALLBACK, mentraUserId})
    const tokens = await redeem(flow)
    const first = tokens.refresh_token!
    expect(first).toBeTruthy()
    const rotated = await client.refreshTokenGrant(flow.config, first)
    expect(rotated.refresh_token).toBeTruthy()
    expect(rotated.refresh_token).not.toBe(first)
    await expect(client.refreshTokenGrant(flow.config, first)).rejects.toMatchObject({error: "invalid_grant"})
    await expect(client.refreshTokenGrant(flow.config, rotated.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
  })

  test("refresh tokens and codes are stored only as hashes", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({clientId: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUri: CONSOLE_CALLBACK, mentraUserId})
    const code = flow.callback.searchParams.get("code")!
    const tokens = await redeem(flow)
    const db = UserModel.db.db!
    const stored = JSON.stringify([
      ...(await db.collection(oidcCollectionName("RefreshToken")).find({}).toArray()),
      ...(await db.collection(oidcCollectionName("AuthorizationCode")).find({}).toArray()),
    ])
    expect(stored).not.toContain(tokens.refresh_token!)
    expect(stored).not.toContain(code)
  })

  test("the revocation endpoint ends a refresh token for its own client only", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({clientId: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUri: CONSOLE_CALLBACK, mentraUserId})
    const tokens = await redeem(flow)
    // Another client cannot revoke it.
    const admin = await rp("admin-portal", "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
    await client.tokenRevocation(admin, tokens.refresh_token!).catch(() => undefined)
    const still = await client.refreshTokenGrant(flow.config, tokens.refresh_token!)
    await client.tokenRevocation(flow.config, still.refresh_token!)
    await expect(client.refreshTokenGrant(flow.config, still.refresh_token!)).rejects.toMatchObject({error: "invalid_grant"})
  })
})

describe("end-session and the provider's cookies", () => {
  test("the provider session cookie is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain (L05)", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({mentraUserId})
    const line = flow.browser.setCookieLines.get("__Host-mentra_oidc_session")!
    expect(line).toBeTruthy()
    const attributes = line.split(";").slice(1).map(part => part.trim().toLowerCase())
    expect(attributes).toEqual(expect.arrayContaining(["path=/", "httponly", "secure", "samesite=lax"]))
    expect(attributes.some(attribute => attribute.startsWith("domain="))).toBe(false)
  })

  test("the provider's cookies authenticate no Core route (L05, Review Focus 4)", async () => {
    const {mentraUserId} = await person({email: "admin@mentra.glass"})
    const flow = await authorize({mentraUserId})
    const cookie = [...flow.browser.cookies(OIDC_ISSUER)].map(([name, c]) => `${name}=${c.value}`).join("; ")
    for (const url of [`${ADMIN_ORIGIN}/api/admin/me`, `${PORTAL_ORIGIN}/api/portal/me`, `${OIDC_ISSUER}/api/admin/me`, `${OIDC_ISSUER}/api/workspaces`]) {
      expect((await app.request(url, {headers: {cookie}})).status).toBe(401)
    }
  })

  test("end-session ends the provider session: the next authorization asks the person to sign in", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({mentraUserId})
    const confirm = await flow.browser.request(`${OIDC_ISSUER}/oidc/session/end`)
    expect(confirm.status).toBe(200)
    expect(confirm.headers.get("cache-control")).toBe("no-store")
    expect(confirm.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    const page = await confirm.text()
    expect(page).toContain("Sign out of Mentra?")
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page)![1]!
    const done = await flow.browser.request(`${OIDC_ISSUER}/oidc/session/end/confirm`, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", origin: OIDC_ISSUER},
      body: new URLSearchParams({xsrf, logout: "yes"}).toString(),
    })
    const success = await flow.browser.follow(new URL(done.headers.get("location")!, OIDC_ISSUER).href, () => false)
    expect("page" in success && (await success.page.text())).toContain("Signed out of Mentra")
    expect(flow.browser.cookies(OIDC_ISSUER).has("__Host-mentra_oidc_session")).toBe(false)

    const config = await rp("admin-portal", "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
    const again = client.buildAuthorizationUrl(config, {
      redirect_uri: ADMIN_CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier()),
      code_challenge_method: "S256",
    })
    const step = await flow.browser.follow(again.href, location => location.pathname.startsWith("/interaction/") || location.href.startsWith(ADMIN_CALLBACK))
    expect("stoppedAt" in step && step.stoppedAt.pathname.startsWith("/interaction/")).toBe(true)
  })

  test("a provider session whose person was revoked asks for a new sign-in", async () => {
    const {mentraUserId} = await person()
    const flow = await authorize({mentraUserId})
    await UserModel.updateOne({mentraUserId}, {$set: {webSignInsRevokedAt: new Date(Date.now() + 2000)}})
    const config = await rp("admin-portal", "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET")
    const again = client.buildAuthorizationUrl(config, {
      redirect_uri: ADMIN_CALLBACK,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier()),
      code_challenge_method: "S256",
    })
    const step = await flow.browser.follow(again.href, location => location.pathname.startsWith("/interaction/") || location.href.startsWith(ADMIN_CALLBACK))
    expect("stoppedAt" in step && step.stoppedAt.pathname.startsWith("/interaction/")).toBe(true)
  })
})

describe("userinfo", () => {
  test("answers a Core access token with the person's claims, and refuses an ID token", async () => {
    const {mentraUserId} = await person({email: "grace@example.com"})
    const tokens = await redeem(await authorize({mentraUserId}))
    const info = await fetch(`${OIDC_ISSUER}/oidc/me`, {headers: {authorization: `Bearer ${tokens.access_token}`}})
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({sub: mentraUserId, email: "grace@example.com", email_verified: true})
    const withIdToken = await fetch(`${OIDC_ISSUER}/oidc/me`, {headers: {authorization: `Bearer ${tokens.id_token}`}})
    expect(withIdToken.status).toBe(401)
  })
})

describe("verifyCoreAccessToken (L07)", () => {
  async function realTokens() {
    const {mentraUserId} = await person()
    return {mentraUserId, tokens: await redeem(await authorize({mentraUserId}))}
  }

  test("refuses another issuer's token, the wrong audience, type or key ID, and an expired token", async () => {
    const {mentraUserId, tokens} = await realTokens()
    const base = {sub: mentraUserId, client_id: "admin-portal", scope: "openid", aud: "urn:mentra:core", iss: OIDC_ISSUER}
    const header = {alg: "EdDSA", kid: "mentra-oidc-1", typ: "at+jwt"}
    expect(await verifyCoreAccessToken(await signWithCoreKey(header, base))).not.toBeNull()
    for (const token of [
      await signWithCoreKey(header, {...base, iss: "https://account.staging.test"}),
      await signWithCoreKey(header, {...base, aud: "cloud-core"}),
      await signWithCoreKey({...header, typ: "JWT"}, base),
      await signWithCoreKey({alg: "EdDSA", kid: "mentra-oidc-1"}, base),
      await signWithCoreKey({...header, kid: "mentra-access-1"}, base),
      // The header is caller-controlled JSON: a non-string typ is refused, never a TypeError.
      await signWithCoreKey({...header, typ: 1} as unknown as jose.JWTHeaderParameters, base),
      await signWithCoreKey({...header, typ: {}} as unknown as jose.JWTHeaderParameters, base),
      await signWithCoreKey(header, base, "-1m"),
      tokens.id_token!,
    ]) {
      expect(await verifyCoreAccessToken(token)).toBeNull()
    }
  })

  test("refuses a token for an unknown client, or for a client whose secret is gone (disabled)", async () => {
    const {mentraUserId} = await realTokens()
    const header = {alg: "EdDSA", kid: "mentra-oidc-1", typ: "at+jwt"}
    const claims = {sub: mentraUserId, aud: "urn:mentra:core", iss: OIDC_ISSUER}
    expect(await verifyCoreAccessToken(await signWithCoreKey(header, {...claims, client_id: "someone-else"}))).toBeNull()
    const token = await signWithCoreKey(header, {...claims, client_id: "console"})
    expect(await verifyCoreAccessToken(token)).not.toBeNull()
    restoreCase = applyEnv({CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: undefined})
    expect(await verifyCoreAccessToken(token)).toBeNull()
  })

  test("refuses a token from before the person's revocation, a deleted account, and a removed sign-in source", async () => {
    const {mentraUserId, tokens} = await realTokens()
    expect(await verifyCoreAccessToken(tokens.access_token)).not.toBeNull()
    await UserModel.updateOne({mentraUserId}, {$set: {webSignInsRevokedAt: new Date(Date.now() + 2000)}})
    expect(await verifyCoreAccessToken(tokens.access_token)).toBeNull()
    await UserModel.updateOne({mentraUserId}, {$set: {webSignInsRevokedAt: null, supportTelemetryDeletedAt: new Date()}})
    expect(await verifyCoreAccessToken(tokens.access_token)).toBeNull()
    await UserModel.updateOne({mentraUserId}, {$set: {supportTelemetryDeletedAt: null}})
    expect(await verifyCoreAccessToken(tokens.access_token)).not.toBeNull()
    restoreCase = applyEnv({CLOUD_CORE_SUPABASE_ISSUER: undefined})
    expect(await verifyCoreAccessToken(tokens.access_token)).toBeNull()
  })

  test("refuses Core's phone, runtime, account subject and miniapp tokens, which share or neighbor its key", async () => {
    const {mentraUserId} = await realTokens()
    const phone = await signWithCoreKey(
      {alg: "EdDSA", kid: "mentra-access-1"},
      {iss: "cloud-core", aud: "cloud-core", sub: mentraUserId, tenant_id: "mentra", session_id: "sess_1", jti: "jti_1"},
    )
    expect(await verifyAccessToken(phone)).toMatchObject({mentraUserId})
    const runtime = (await issueRuntimeToken({mentraUserId, tenantId: "mentra"})).token
    const account = await mintAccountSubjectToken({tenantUserId: "supa-x"})
    const miniapp = (await issueMiniappToken({mentraUserId, tenantId: "mentra", packageName: "com.example.app"})).token
    for (const token of [phone, runtime, account, miniapp]) expect(await verifyCoreAccessToken(token)).toBeNull()
  })
})

describe("Core's other verifiers refuse the provider's tokens", () => {
  test("with the Private Cloud shape (CLOUD_CORE_ISSUER equal to the provider's issuer), phone and provider tokens still never pass for each other", async () => {
    const {mentraUserId} = await person()
    const tokens = await redeem(await authorize({mentraUserId}))
    restoreCase = applyEnv({CLOUD_CORE_ISSUER: OIDC_ISSUER})
    resetCoreKeyCaches()
    for (const token of [tokens.access_token, tokens.id_token!]) await expect(verifyAccessToken(token)).rejects.toThrow()
    const phone = await signWithCoreKey(
      {alg: "EdDSA", kid: "mentra-access-1"},
      {iss: OIDC_ISSUER, aud: "cloud-core", sub: mentraUserId, tenant_id: "mentra", session_id: "sess_1", jti: "jti_1"},
    )
    expect(await verifyAccessToken(phone)).toMatchObject({mentraUserId})
    expect(await verifyCoreAccessToken(phone)).toBeNull()
  })

  test("the phone access token check and the account API refuse provider access and ID tokens", async () => {
    const {mentraUserId} = await person()
    const tokens = await redeem(await authorize({mentraUserId}))
    for (const token of [tokens.access_token, tokens.id_token!]) {
      await expect(verifyAccessToken(token)).rejects.toThrow()
      // Refused as the account API refuses any invalid access token (invalid_grant).
      for (const response of [
        await app.request("https://core.test/api/account/me", {headers: {authorization: `Bearer ${token}`}}),
        await app.request("https://core.test/api/client/auth/miniapp-token", {method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"}, body: JSON.stringify({packageName: "com.example.app"})}),
      ]) {
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
      }
    }
  })

  test("the phone token exchange never turns a provider token into a phone session", async () => {
    const {mentraUserId} = await person()
    const tokens = await redeem(await authorize({mentraUserId}))
    for (const token of [tokens.access_token, tokens.id_token!]) {
      const response = await app.request("https://core.test/api/client/auth/exchange", {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          subject_token: token,
        }).toString(),
      })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      expect(JSON.stringify(await response.json())).not.toContain("access_token\":\"ey")
    }
  })

  test("Runtime refuses provider tokens even from a trusted issuer on Core's key", async () => {
    const {mentraUserId} = await person()
    const tokens = await redeem(await authorize({mentraUserId}))
    restoreCase = applyEnv({
      CLOUD_RUNTIME_AUTH_ISSUERS: JSON.stringify([
        {issuer: OIDC_ISSUER, publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY", tenantIdClaim: "tenant_id"},
        {issuer: "cloud-core", publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY", tenantIdClaim: "tenant_id"},
      ]),
      CLOUD_RUNTIME_AUTH_AUDIENCE: "urn:mentra:core",
    })
    for (const token of [tokens.access_token, tokens.id_token!]) await expect(verifyRuntimeToken(token)).rejects.toThrow("not a runtime token")
  })

  test("a miniapp backend (@mentra/auth) refuses provider tokens served from Core's key set", async () => {
    const {mentraUserId} = await person()
    const tokens = await redeem(await authorize({mentraUserId}))
    for (const [token, audience] of [[tokens.access_token, "urn:mentra:core"], [tokens.id_token!, "admin-portal"]] as const) {
      const auth = createMentraAuth({packageName: audience, jwksUrl: `${OIDC_ISSUER}/.well-known/jwks.json`, issuer: OIDC_ISSUER})
      await expect(auth.verifyToken(token)).rejects.toThrow("unexpected key ID")
    }
  })
})
