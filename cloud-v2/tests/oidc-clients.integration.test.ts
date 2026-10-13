/**
 * @fileoverview The clients of Core's sign-in server (L02, L14): the
 * configured first-party clients (`CLOUD_CORE_OIDC_CLIENTS`), exact redirect
 * URIs, client authentication, and no dynamic registration.
 *
 * Runs Core's real app in-process; the issuer's origin is routed to it, as the
 * sign-in site's relay does. openid-client 6.8.8 is the relying party.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/oidc-clients.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test} from "bun:test"
import * as client from "openid-client"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {ensureOidcCollections} from "../packages/core/src/services/oidc/mongo-adapter"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_CALLBACK,
  Browser,
  CLI_CALLBACK,
  CLIENT_SECRETS,
  CONSOLE_CALLBACK,
  coreKeyEnv,
  finishInteraction,
  OIDC_ISSUER,
  PORTAL_CALLBACK,
  providerEnv,
  routeOriginsToApp,
  signedInPerson,
} from "./support/oidc-harness"
import {applyEnv} from "./support/signin-harness"

setDefaultTimeout(30_000)

const databaseUrl = localTestMongoUrl("oidc-clients")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
let restoreCase: () => void = () => {}

beforeAll(async () => {
  restoreEnv = applyEnv({
    ...coreKeyEnv(),
    ...providerEnv(),
    CLOUD_CORE_SUPABASE_ISSUER: "https://signin.supabase.co/auth/v1",
    CLOUD_CORE_OIDC_PROVIDERS: undefined,
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

afterEach(() => {
  restoreCase()
  restoreCase = () => {}
})

const SECRET_FOR: Record<string, string | undefined> = {
  "admin-portal": CLIENT_SECRETS.CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET,
  "workspace-portal": CLIENT_SECRETS.CLOUD_CORE_OIDC_WORKSPACE_PORTAL_CLIENT_SECRET,
  console: CLIENT_SECRETS.CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET,
}

async function rp(clientId: string, auth?: client.ClientAuth): Promise<client.Configuration> {
  const secret = SECRET_FOR[clientId]
  return client.discovery(
    new URL(OIDC_ISSUER),
    clientId,
    {...(secret ? {client_secret: secret} : {}), id_token_signed_response_alg: "EdDSA"},
    auth ?? (secret ? client.ClientSecretPost(secret) : client.None()),
  )
}

async function authorizationUrl(config: client.Configuration, redirectUri: string, extra: Record<string, string> = {}) {
  const verifier = client.randomPKCECodeVerifier()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: client.randomState(),
    ...extra,
  })
  return {url, verifier, state: url.searchParams.get("state")!}
}

let counter = 0
async function person() {
  counter++
  return signedInPerson({subject: `supa-c${counter}`, email: `c${counter}@example.com`, emailVerified: true})
}

/** Follow the authorization request, recording every page and interaction it passes through. */
async function run(browser: Browser, start: URL, redirectUri: string, mentraUserId?: string) {
  const visited: string[] = []
  let step = await browser.follow(start.href, location => {
    visited.push(location.pathname)
    return location.href.startsWith(redirectUri) || location.pathname.startsWith("/interaction/")
  })
  if ("stoppedAt" in step && step.stoppedAt.pathname.startsWith("/interaction/")) {
    if (!mentraUserId) return {visited, interaction: step.stoppedAt}
    const resume = await finishInteraction(step.stoppedAt, mentraUserId, {consent: false})
    step = await browser.follow(resume.href, location => {
      visited.push(location.pathname)
      return location.href.startsWith(redirectUri) || location.pathname.startsWith("/interaction/")
    })
  }
  return {visited, step}
}

describe("first-party clients (L02)", () => {
  test("a first-party client is granted without a consent screen", async () => {
    const {mentraUserId} = await person()
    const config = await rp("admin-portal")
    const {url, verifier, state} = await authorizationUrl(config, ADMIN_CALLBACK)
    const result = await run(new Browser(app), url, ADMIN_CALLBACK, mentraUserId)
    // The only interaction is the sign-in itself; no consent step follows it.
    expect(result.visited.filter(path => path.startsWith("/interaction/"))).toHaveLength(1)
    const callback = (result.step as {stoppedAt: URL}).stoppedAt
    const tokens = await client.authorizationCodeGrant(config, callback, {pkceCodeVerifier: verifier, expectedState: state})
    expect(tokens.claims()!.sub).toBe(mentraUserId)
  })

  test("a second site in the same environment signs in without credentials or any interaction", async () => {
    const {mentraUserId} = await person()
    const browser = new Browser(app)
    const admin = await rp("admin-portal")
    await run(browser, (await authorizationUrl(admin, ADMIN_CALLBACK)).url, ADMIN_CALLBACK, mentraUserId)

    const portal = await rp("workspace-portal")
    const {url, verifier, state} = await authorizationUrl(portal, PORTAL_CALLBACK)
    const second = await run(browser, url, PORTAL_CALLBACK)
    expect(second.visited.some(path => path.startsWith("/interaction/"))).toBe(false)
    const tokens = await client.authorizationCodeGrant(portal, (second.step as {stoppedAt: URL}).stoppedAt, {pkceCodeVerifier: verifier, expectedState: state})
    expect(tokens.claims()).toMatchObject({sub: mentraUserId, aud: "workspace-portal"})
  })

  test("the portals get no refresh token, even asking for offline_access; the Console does", async () => {
    const {mentraUserId} = await person()
    const browser = new Browser(app)
    for (const [clientId, redirectUri, expectRefresh] of [
      ["admin-portal", ADMIN_CALLBACK, false],
      ["console", CONSOLE_CALLBACK, true],
    ] as const) {
      const config = await rp(clientId)
      const {url, verifier, state} = await authorizationUrl(config, redirectUri, {scope: "openid email profile offline_access"})
      const result = await run(browser, url, redirectUri, mentraUserId)
      const tokens = await client.authorizationCodeGrant(config, (result.step as {stoppedAt: URL}).stoppedAt, {pkceCodeVerifier: verifier, expectedState: state})
      expect(Boolean(tokens.refresh_token)).toBe(expectRefresh)
    }
  })

  test("the CLI is a public client: S256 PKCE, no secret, a loopback redirect and a refresh token", async () => {
    const {mentraUserId} = await person()
    const config = await rp("mentra-cli")
    const {url, verifier, state} = await authorizationUrl(config, CLI_CALLBACK)
    const browser = new Browser(app)
    let result = await run(browser, url, CLI_CALLBACK, mentraUserId)
    if (!("step" in result) || !result.step || !("stoppedAt" in result.step) || !result.step.stoppedAt.href.startsWith(CLI_CALLBACK)) {
      // A native client's authorization always passes the consent step, which Core completes for first-party clients.
      const interaction = (result as {interaction?: URL}).interaction ?? (result.step as {stoppedAt: URL}).stoppedAt
      const resume = await finishInteraction(interaction, mentraUserId)
      result = {visited: [], step: await browser.follow(resume.href, location => location.href.startsWith(CLI_CALLBACK))}
    }
    const tokens = await client.authorizationCodeGrant(config, (result.step as {stoppedAt: URL}).stoppedAt, {pkceCodeVerifier: verifier, expectedState: state})
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.claims()!.aud).toBe("mentra-cli")
  })
})

describe("unknown clients and redirect URIs get no authorization", () => {
  async function expectNoAuthorization(url: URL) {
    const response = await new Browser(app).request(url)
    expect(response.status).toBe(400)
    expect(response.headers.get("location")).toBeNull()
  }

  test("an unknown client", async () => {
    const {url} = await authorizationUrl(await rp("admin-portal"), ADMIN_CALLBACK)
    url.searchParams.set("client_id", "miniapp-website")
    await expectNoAuthorization(url)
  })

  test.each([
    ["a trailing slash", `${ADMIN_CALLBACK}/`],
    ["another port", "https://admin.test:8443/api/admin/auth/callback"],
    ["an added query", `${ADMIN_CALLBACK}?next=/`],
    ["plain HTTP", ADMIN_CALLBACK.replace("https:", "http:")],
    ["another path", "https://admin.test/api/portal/auth/callback"],
    ["another client's redirect", PORTAL_CALLBACK],
  ])("a redirect URI with %s", async (_label, redirectUri) => {
    const {url} = await authorizationUrl(await rp("admin-portal"), redirectUri)
    await expectNoAuthorization(url)
  })

  test("a confidential client whose secret variable is unset is unknown", async () => {
    const {url} = await authorizationUrl(await rp("admin-portal"), ADMIN_CALLBACK)
    restoreCase = applyEnv({CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: undefined})
    await expectNoAuthorization(url)
  })
})

describe("client authentication at the token endpoint", () => {
  async function codeFor(clientId: string, redirectUri: string) {
    const {mentraUserId} = await person()
    const config = await rp(clientId)
    const {url, verifier, state} = await authorizationUrl(config, redirectUri)
    const result = await run(new Browser(app), url, redirectUri, mentraUserId)
    return {callback: (result.step as {stoppedAt: URL}).stoppedAt, verifier, state}
  }

  test("a wrong secret is refused with invalid_client, however it is sent", async () => {
    const wrong = "wrong-secret-0123456789abcdef0123456789"
    for (const auth of [client.ClientSecretPost(wrong), client.ClientSecretBasic(wrong), client.None()]) {
      const {callback, verifier, state} = await codeFor("admin-portal", ADMIN_CALLBACK)
      const config = await rp("admin-portal", auth)
      const error = (await client.authorizationCodeGrant(config, callback, {pkceCodeVerifier: verifier, expectedState: state}).catch(err => err)) as {
        error?: string
        status?: number
        cause?: Array<{parameters?: {error?: string}}>
      }
      // A refused Basic credential answers 401 with a WWW-Authenticate challenge; the others answer invalid_client.
      expect(error.error ?? error.cause?.[0]?.parameters?.error).toBe("invalid_client")
    }
  })

  test("a wrong PKCE verifier is refused", async () => {
    const {callback, state} = await codeFor("admin-portal", ADMIN_CALLBACK)
    const config = await rp("admin-portal")
    await expect(client.authorizationCodeGrant(config, callback, {pkceCodeVerifier: client.randomPKCECodeVerifier(), expectedState: state})).rejects.toMatchObject({error: "invalid_grant"})
  })
})

describe("dynamic client registration (L14)", () => {
  test("is not offered and is refused", async () => {
    const metadata = (await (await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`)).json()) as Record<string, unknown>
    expect(metadata.registration_endpoint).toBeUndefined()
    for (const path of ["/oidc/reg", "/reg", "/oidc/register"]) {
      const response = await fetch(`${OIDC_ISSUER}${path}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({redirect_uris: ["https://evil.test/cb"], token_endpoint_auth_method: "none"}),
      })
      expect(response.status).toBe(404)
    }
  })
})
