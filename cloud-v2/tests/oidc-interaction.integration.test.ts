/**
 * @fileoverview Signing in to Core's sign-in server (L01, L03, L06, L07, L13,
 * Review Focus 1, S01, S02):
 *  - hosted Core: the sign-in page hands the person's Supabase access token to
 *    the provider interaction; Core verifies it, resolves the Mentra App's
 *    Core user, ends that Supabase session and answers the provider's own
 *    continuation;
 *  - a Mentra Private Cloud: the provider is a confidential client of the
 *    customer's Entra, with no Supabase.
 *
 * Runs Core's real app in-process against fake identity providers (fetch
 * interception). openid-client is the website relying party.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/oidc-interaction.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as client from "openid-client"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {verifyCoreAccessToken} from "../packages/core/src/services/oidc/core-access-token"
import {registerAfterSignInHook} from "../packages/core/src/services/oidc/interactions"
import {ensureOidcCollections} from "../packages/core/src/services/oidc/mongo-adapter"
import {resetUpstreamCaches} from "../packages/core/src/services/oidc/upstream"
import type {SessionIdentity} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_CALLBACK,
  Browser,
  CLI_CALLBACK,
  CLIENT_SECRETS,
  coreKeyEnv,
  OIDC_ISSUER,
  providerEnv,
  routeOriginsToApp,
} from "./support/oidc-harness"
import {
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  HOSTED_ENV,
  PRIVATE_CLOUD_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const databaseUrl = localTestMongoUrl("oidc-interaction")
let verified = false
let app: ReturnType<typeof createApp>
let restoreBase: () => void = () => {}
let restoreFetch: () => void = () => {}
let restoreMode: () => void = () => {}
const hookCalls: SessionIdentity[] = []
const nowSec = () => Math.floor(Date.now() / 1000)

beforeAll(async () => {
  restoreBase = applyEnv({...coreKeyEnv(), ...providerEnv(), REFRESH_TOKEN_PEPPER: "oidc-interaction-pepper"})
  resetCoreKeyCaches()
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([
    UserModel.syncIndexes(),
    SigninIdentityModel.syncIndexes(),
    LoginTransactionModel.syncIndexes(),
    AuthRateLimitModel.syncIndexes(),
    ensureOidcCollections(),
  ])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
  registerAfterSignInHook(async identity => {
    hookCalls.push(identity)
  })
})

afterAll(async () => {
  await stopOidcBridge()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
  restoreBase()
  resetCoreKeyCaches()
})

async function clean() {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all([AuthRateLimitModel.deleteMany({}), LoginTransactionModel.deleteMany({})])
  resetIdpTokenCaches()
  resetUpstreamCaches()
  hookCalls.length = 0
}

async function rp(clientId = "admin-portal"): Promise<client.Configuration> {
  const secret = clientId === "admin-portal" ? CLIENT_SECRETS.CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET : undefined
  return client.discovery(
    new URL(OIDC_ISSUER),
    clientId,
    {...(secret ? {client_secret: secret} : {}), id_token_signed_response_alg: "EdDSA"},
    secret ? client.ClientSecretPost(secret) : client.None(),
  )
}

/** Start a website's sign-in and follow it to the provider's interaction. */
async function startSignIn(opts: {clientId?: string; redirectUri?: string} = {}) {
  const config = await rp(opts.clientId)
  const redirectUri = opts.redirectUri ?? ADMIN_CALLBACK
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
  const browser = new Browser(app)
  const step = await browser.follow(url.href, location => location.pathname.startsWith("/interaction/"))
  if (!("stoppedAt" in step)) throw new Error("no interaction")
  const interaction = step.stoppedAt
  const uid = interaction.pathname.split("/")[2]!
  return {config, browser, interaction, uid, verifier, state, nonce, redirectUri}
}

type SignIn = Awaited<ReturnType<typeof startSignIn>>

async function finishAtClient(signIn: SignIn, continuation: string) {
  const step = await signIn.browser.follow(continuation, location => location.href.startsWith(signIn.redirectUri))
  if (!("stoppedAt" in step)) throw new Error("no redirect to the client")
  return client.authorizationCodeGrant(signIn.config, step.stoppedAt, {
    pkceCodeVerifier: signIn.verifier,
    expectedState: signIn.state,
    expectedNonce: signIn.nonce,
    idTokenExpected: true,
  })
}

describe("hosted Core: the sign-in page's hand-off", () => {
  let supabase: FakeIdp

  beforeEach(async () => {
    restoreMode = applyEnv({...HOSTED_ENV, ...providerEnv()})
    await clean()
    supabase = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
    restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
  })

  afterEach(() => {
    restoreFetch()
    supabase.restore()
    restoreMode()
  })

  /** A token of the sign-in page's own Supabase session for `sub`. */
  async function pageSession(sub: string, opts: {email?: string; startedAt?: number; claims?: Record<string, unknown>; emailConfirmed?: boolean} = {}) {
    const email = opts.email ?? `${sub}@example.com`
    supabase.registerUser({sub, email, emailConfirmed: opts.emailConfirmed ?? true})
    const session = supabase.startSession(sub, null, opts.startedAt)
    const token = await supabase.mint({
      sub,
      aud: "authenticated",
      role: "authenticated",
      email,
      session_id: session.sessionId,
      amr: [{method: "password", timestamp: session.startedAt}],
      user_metadata: {email_verified: true},
      ...opts.claims,
    })
    return {token, session}
  }

  function handoff(signIn: SignIn, token: string, headers: Record<string, string> = {origin: OIDC_ISSUER}) {
    return signIn.browser.request(`${OIDC_ISSUER}/interaction/${signIn.uid}/supabase`, {
      method: "POST",
      headers: {"content-type": "application/json", ...headers},
      body: JSON.stringify({access_token: token, redirect_url: "https://evil.test/steal"}),
    })
  }

  test("the interaction sends the person to the sign-in page's login route", async () => {
    const signIn = await startSignIn()
    const response = await signIn.browser.request(signIn.interaction)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${OIDC_ISSUER}/login?interaction=${signIn.uid}`)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const details = await signIn.browser.request(`${OIDC_ISSUER}/interaction/${signIn.uid}/details`)
    expect(await details.json()).toEqual({prompt: "login", client: {name: "Mentra admin portal"}, scopes: ["openid", "email", "profile"]})
  })

  test("a hand-off signs in the Mentra App's Core user, ends that Supabase session, and redirects only to the provider's continuation (L01, L13, Review Focus 1)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-ada"})
    const signIn = await startSignIn()
    const {token, session} = await pageSession("supa-ada", {email: "ada@example.com"})
    const response = await handoff(signIn, token)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const {redirectTo} = (await response.json()) as {redirectTo: string}
    expect(redirectTo.startsWith(`${OIDC_ISSUER}/oidc/auth/`)).toBe(true)

    // Core ended the page's Supabase session with that token: it is useless afterwards.
    expect(supabase.sessions.get(session.sessionId)!.endedAt).not.toBeNull()
    expect(supabase.logoutCalls.at(-1)).toMatchObject({scope: "local", sessionId: session.sessionId})

    const tokens = await finishAtClient(signIn, redirectTo)
    expect(tokens.claims()).toMatchObject({sub: phoneUser.mentraUserId, email: "ada@example.com", email_verified: true})
    expect(hookCalls.map(identity => identity.mentraUserId)).toEqual([phoneUser.mentraUserId])
    expect(hookCalls[0]).toMatchObject({tenantId: "mentra", sourceId: "mentra", subject: "supa-ada"})
    // No token the website holds is a Supabase token.
    for (const value of [tokens.access_token, tokens.id_token!]) expect(value).not.toBe(token)
  })

  test("email verification comes from the account's email_confirmed_at, never the token", async () => {
    const signIn = await startSignIn()
    const {token} = await pageSession("supa-unconfirmed", {emailConfirmed: false, claims: {user_metadata: {email_verified: true}}})
    const {redirectTo} = (await (await handoff(signIn, token)).json()) as {redirectTo: string}
    const tokens = await finishAtClient(signIn, redirectTo)
    expect(tokens.claims()!.email_verified).toBe(false)
    expect((await verifyCoreAccessToken(tokens.access_token))?.emailVerified).toBe(false)
  })

  test("a failing Supabase logout still signs the person in", async () => {
    const signIn = await startSignIn()
    const {token} = await pageSession("supa-logout-down")
    supabase.failLogout = true
    const response = await handoff(signIn, token)
    expect(response.status).toBe(200)
  })

  describe("each refused with 401 and no sign-in (L07)", () => {
    const cases: Array<[string, (sub: string) => Promise<string>]> = [
      ["a session that started before webSignInsRevokedAt, even refreshed after it", async sub => {
        const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
        const startedAt = nowSec() - 120
        await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((nowSec() - 60) * 1000)}})
        return (await pageSession(sub, {startedAt, claims: {iat: nowSec()}})).token
      }],
      ["a token issued to an OAuth client", async sub => (await pageSession(sub, {claims: {client_id: "admin-client"}})).token],
      ["the wrong issuer", async sub => (await pageSession(sub, {claims: {iss: "https://other.supabase.co/auth/v1"}})).token],
      ["the wrong audience", async sub => (await pageSession(sub, {claims: {aud: "anon"}})).token],
      ["an expired token", async sub => (await pageSession(sub, {claims: {iat: nowSec() - 7200, exp: nowSec() - 3600}})).token],
      ["no amr session start", async sub => (await pageSession(sub, {claims: {amr: undefined}})).token],
      ["alg none", async sub => {
        const {token} = await pageSession(sub)
        const [, payload] = token.split(".")
        return `${Buffer.from(JSON.stringify({alg: "none", typ: "JWT"})).toString("base64url")}.${payload}.`
      }],
      ["a deleted account", async sub => {
        const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
        await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
        return (await pageSession(sub)).token
      }],
    ]
    let counter = 0
    for (const [label, mint] of cases) {
      test(label, async () => {
        const signIn = await startSignIn()
        const token = await mint(`supa-refused-${++counter}`)
        const response = await handoff(signIn, token)
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({error: "sign_in_refused"})
        expect(hookCalls).toHaveLength(0)
        // The interaction is still waiting for a sign-in.
        expect((await signIn.browser.request(signIn.interaction)).headers.get("location")).toContain("/login?interaction=")
      })
    }
  })

  test("a session that started after the revocation signs in", async () => {
    const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-after"})
    await UserModel.updateOne({mentraUserId: user.mentraUserId}, {$set: {webSignInsRevokedAt: new Date((nowSec() - 60) * 1000)}})
    const signIn = await startSignIn()
    const {token} = await pageSession("supa-after", {startedAt: nowSec() - 10})
    expect((await handoff(signIn, token)).status).toBe(200)
  })

  test("cross-origin hand-offs are refused before anything is checked", async () => {
    const signIn = await startSignIn()
    const {token, session} = await pageSession("supa-csrf")
    for (const headers of [{origin: "https://evil.test"}, {"sec-fetch-site": "cross-site"}, {} as Record<string, string>]) {
      expect((await handoff(signIn, token, headers)).status).toBe(403)
    }
    expect((await handoff(signIn, token, {"sec-fetch-site": "same-origin"})).status).toBe(200)
    expect(supabase.sessions.get(session.sessionId)!.endedAt).not.toBeNull()
  })

  test("without this browser's interaction cookie, or for another interaction, nothing is signed in", async () => {
    const signIn = await startSignIn()
    const other = await startSignIn()
    const {token} = await pageSession("supa-cookie")
    const stranger = new Browser(app)
    const response = await stranger.request(`${OIDC_ISSUER}/interaction/${signIn.uid}/supabase`, {
      method: "POST",
      headers: {"content-type": "application/json", origin: OIDC_ISSUER},
      body: JSON.stringify({access_token: token}),
    })
    expect(response.status).toBe(400)
    const crossed = await signIn.browser.request(`${OIDC_ISSUER}/interaction/${other.uid}/supabase`, {
      method: "POST",
      headers: {"content-type": "application/json", origin: OIDC_ISSUER},
      body: JSON.stringify({access_token: token}),
    })
    expect(crossed.status).toBe(400)
    expect(hookCalls).toHaveLength(0)
  })

  test("the hand-off is rate-limited per IP", async () => {
    const signIn = await startSignIn()
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const response = await signIn.browser.request(`${OIDC_ISSUER}/interaction/${signIn.uid}/supabase`, {
        method: "POST",
        headers: {"content-type": "application/json", origin: OIDC_ISSUER, "x-forwarded-for": "203.0.113.9"},
        body: JSON.stringify({access_token: "not-a-token"}),
      })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 30).every(status => status === 401)).toBe(true)
    expect(statuses[30]).toBe(429)
  })

  test("a Supabase key set outage fails the hand-off closed (S02)", async () => {
    const signIn = await startSignIn()
    supabase.registerUser({sub: "supa-outage", email: "o@example.com"})
    const es = await supabase.mint({sub: "supa-outage", aud: "authenticated", email: "o@example.com"}, {alg: "ES256"})
    supabase.outage = true
    const response = await handoff(signIn, es)
    expect(response.status).toBe(503)
    expect(hookCalls).toHaveLength(0)
  })

  test("the CLI, a native first-party client, sees no consent screen", async () => {
    const signIn = await startSignIn({clientId: "mentra-cli", redirectUri: CLI_CALLBACK})
    const {token} = await pageSession("supa-cli")
    const {redirectTo} = (await (await handoff(signIn, token)).json()) as {redirectTo: string}
    const visited: string[] = []
    const step = await signIn.browser.follow(redirectTo, location => {
      visited.push(location.pathname)
      return location.href.startsWith(CLI_CALLBACK)
    })
    expect("stoppedAt" in step).toBe(true)
    expect(visited.some(path => path === "/consent")).toBe(false)
    const tokens = await client.authorizationCodeGrant(signIn.config, (step as {stoppedAt: URL}).stoppedAt, {
      pkceCodeVerifier: signIn.verifier,
      expectedState: signIn.state,
      expectedNonce: signIn.nonce,
    })
    expect(tokens.refresh_token).toBeTruthy()
  })
})

describe("a Private Cloud: the customer's Entra behind Core's provider", () => {
  let entra: FakeIdp
  const ENTRA_CALLBACK = `${OIDC_ISSUER}/interaction/callback/workforce`

  beforeEach(async () => {
    // The Private Cloud shape, with this suite's issuer and clients (portal-signin covers Core's one host).
    restoreMode = applyEnv({...PRIVATE_CLOUD_ENV, ...providerEnv()})
    await clean()
    entra = await installFakeIdp({
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      kind: "oidc",
      clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [ENTRA_CALLBACK]}],
    })
    restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
  })

  afterEach(() => {
    restoreFetch()
    entra.restore()
    restoreMode()
  })

  async function toEntra(signIn: SignIn) {
    const response = await signIn.browser.request(signIn.interaction)
    expect(response.status).toBe(303)
    const authorize = new URL(response.headers.get("location")!)
    expect(authorize.origin + authorize.pathname).toBe(`${ENTRA_ISSUER}/authorize`)
    return authorize
  }

  test("an Entra sign-in resolves (tenantId, oid), the phone's Core user, with no Supabase (L03)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "oid-it-admin"})
    const signIn = await startSignIn()
    const authorize = await toEntra(signIn)
    expect(authorize.searchParams.get("redirect_uri")).toBe(ENTRA_CALLBACK)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("nonce")).toBeTruthy()
    expect(signIn.browser.cookies(OIDC_ISSUER).has("__Host-mentra_signin_tx")).toBe(true)
    const callback = await entra.approve(authorize, {sub: "pairwise", email: "it-admin@contoso.com", claims: {oid: "oid-it-admin", tid: ENTRA_TENANT}})
    const back = await signIn.browser.request(callback)
    expect(back.status).toBe(303)
    const tokens = await finishAtClient(signIn, new URL(back.headers.get("location")!, OIDC_ISSUER).href)
    expect(tokens.claims()).toMatchObject({sub: phoneUser.mentraUserId, email: "it-admin@contoso.com", email_verified: true})
    expect(entra.tokenRequests.at(-1)).toMatchObject({auth: "client_secret_post", clientId: CORE_API_CLIENT})
    expect(hookCalls[0]).toMatchObject({tenantId: "contoso", sourceId: "workforce", subject: "oid-it-admin"})
  })

  test("an email outside the provider's verified domains is not verified (L06)", async () => {
    const signIn = await startSignIn()
    const callback = await entra.approve(await toEntra(signIn), {sub: "p", email: "alex@mentra.glass", claims: {oid: "oid-outside", tid: ENTRA_TENANT}})
    const back = await signIn.browser.request(callback)
    const tokens = await finishAtClient(signIn, new URL(back.headers.get("location")!, OIDC_ISSUER).href)
    expect(tokens.claims()).toMatchObject({email: "alex@mentra.glass", email_verified: false})
  })

  test.each([
    ["a wrong nonce", {idTokenClaims: {nonce: "other"}}],
    ["another directory", {claims: {oid: "oid-x", tid: "other-directory"}}],
    ["a wrong audience", {idTokenClaims: {aud: "someone-else"}}],
    ["an HS256-signed ID token", {idTokenAlg: "HS256" as const}],
    ["an expired ID token", {idTokenClaims: {exp: nowSec() - 3600}}],
  ])("%s signs nobody in", async (_label, person) => {
    const signIn = await startSignIn()
    const authorize = await toEntra(signIn)
    const callback = await entra.approve(authorize, {sub: "p", email: "it@contoso.com", claims: {oid: "oid-refused", tid: ENTRA_TENANT}, ...person})
    const back = await signIn.browser.request(callback)
    expect(back.status).toBeGreaterThanOrEqual(400)
    expect(back.headers.get("location")).toBeNull()
    expect(hookCalls).toHaveLength(0)
  })

  test("a callback without the transaction cookie, or a replayed state, signs nobody in", async () => {
    const signIn = await startSignIn()
    const callback = await entra.approve(await toEntra(signIn), {sub: "p", email: "it@contoso.com", claims: {oid: "oid-tx", tid: ENTRA_TENANT}})
    const stranger = new Browser(app)
    expect((await stranger.request(callback)).status).toBe(400)
    const back = await signIn.browser.request(callback)
    expect(back.status).toBe(303)
    const replay = await signIn.browser.request(callback)
    expect(replay.status).toBe(400)
    expect(hookCalls).toHaveLength(1)
  })
})
