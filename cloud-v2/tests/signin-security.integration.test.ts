/**
 * @fileoverview Security of Core's sign-in surfaces (S01, S02): the portals'
 * sign-in routes and Core's sign-in server.
 *
 *  - S01: every auth response is `no-store`; the portal login and callback,
 *    the provider's hand-off and its token endpoint answer 429 past their
 *    limits; the request logger never records a query string; and a full
 *    sign-in through Core's sign-in server, a bearer request, a refresh and a
 *    sign-out, run in a real Core process, leave no code, token, handed-off
 *    Supabase token, secret or cookie value in its logs.
 *  - S02: a discovery outage, a sign-in server outage during the code
 *    exchange, and a database outage mid-flow fail closed, with no session,
 *    grant or Set-Cookie.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the databases are dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/signin-security.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import {createServer} from "node:net"
import {resolve} from "node:path"

import * as client from "openid-client"

import {createApp} from "../packages/core/src/api/app"
import {requestContext} from "../packages/core/src/api/middleware/context.middleware"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {stopOidcBridge} from "../packages/core/src/services/oidc/bridge"
import {ensureOidcCollections, oidcCollectionName} from "../packages/core/src/services/oidc/mongo-adapter"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {installFakeIdp, startFakeIdpServer, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {Browser, coreKeyEnv, routeOriginsToApp} from "./support/oidc-harness"
import {
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  cookieValue,
  HOSTED_ENV,
  OIDC_ISSUER,
  PORTAL_ORIGIN,
  portalSignIn,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
  TX_COOKIE,
} from "./support/signin-harness"

setDefaultTimeout(60_000)

const CLOUD_V2 = resolve(import.meta.dir, "..")
const databaseUrl = localTestMongoUrl("signin-security")
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
const ADMIN_PERSON = {sub: "supa-security", email: ADMIN_EMAIL, emailConfirmed: true}
const MODELS = [UserModel, BrowserSessionModel, LoginTransactionModel, AuthRateLimitModel, SigninIdentityModel]

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all([...MODELS.map(model => model.syncIndexes()), ensureOidcCollections()])
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  await stopOidcBridge()
  if (verified) {
    if (UserModel.db.readyState !== 1) await connectMongo(databaseUrl)
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv(HOSTED_ENV)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  idp = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
  restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
})

afterEach(() => {
  restoreFetch()
  idp.restore()
  restoreEnv()
})

/** Make this process's `fetch` to the issuer fail like an outage, until the returned function runs. */
function issuerOutage(kind: "unreachable" | "503", paths?: string[]): () => void {
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.origin === OIDC_ISSUER && (!paths || paths.includes(url.pathname))) {
      if (kind === "unreachable") throw new TypeError("fetch failed")
      return new Response(JSON.stringify({error: "temporarily_unavailable"}), {status: 503, headers: {"content-type": "application/json"}})
    }
    return inner(input as RequestInfo, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = inner
  }
}

describe("S01: auth responses are no-store", () => {
  test("the portals' login, callback, error pages and logout", async () => {
    const responses: Response[] = []
    for (const [portal, origin] of [["admin", ADMIN_ORIGIN], ["portal", PORTAL_ORIGIN]] as const) {
      responses.push(await app.request(`${origin}/api/${portal}/auth/login`))
      responses.push(await app.request(`${origin}/api/${portal}/auth/callback?code=x&state=y`))
      responses.push(await app.request(`${origin}/api/${portal}/auth/logout`, {method: "POST", headers: {origin}}))
      responses.push(await app.request(`${origin}/api/${portal}/auth/logout`, {method: "POST", headers: {origin: "https://evil.example"}}))
    }
    const success = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    responses.push(success.login, success.done)
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("Core's sign-in server: discovery, authorization, the sign-in step, the hand-off, end-session and errors", async () => {
    const browser = new Browser(app)
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    const authorize = await browser.request(login.headers.get("location")!)
    const interaction = await browser.request(new URL(authorize.headers.get("location")!, OIDC_ISSUER))
    const uid = new URL(authorize.headers.get("location")!, OIDC_ISSUER).pathname.split("/")[2]!
    const handoff = await browser.request(`${OIDC_ISSUER}/interaction/${uid}/supabase`, {
      method: "POST",
      headers: {"content-type": "application/json", origin: OIDC_ISSUER},
      body: JSON.stringify({access_token: "not-a-token"}),
    })
    const responses = [
      await app.request(`${OIDC_ISSUER}/.well-known/openid-configuration`),
      authorize,
      interaction,
      handoff,
      await browser.request(`${OIDC_ISSUER}/oidc/session/end`),
      await app.request(`${OIDC_ISSUER}/oidc/auth?client_id=unknown`),
      await app.request(`${OIDC_ISSUER}/oidc/token`, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: "grant_type=authorization_code&code=x&client_id=admin-portal"}),
      await app.request(`${OIDC_ISSUER}/interaction/not-an-interaction-uid`),
    ]
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("a not-configured portal answers no-store too", async () => {
    const restore = applyEnv({CLOUD_CORE_OIDC_ISSUER: undefined})
    try {
      const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
      expect(login.status).toBe(503)
      expect(login.headers.get("cache-control")).toBe("no-store")
    } finally {
      restore()
    }
  })

  test("the portal login and callback limits answer 429", async () => {
    const ip = {"x-forwarded-for": "192.0.2.44"}
    let last: Response | undefined
    for (let i = 0; i < 21; i++) last = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {headers: ip})
    expect(last!.status).toBe(429)
    for (let i = 0; i < 31; i++) last = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/callback?code=c&state=s`, {headers: ip})
    expect(last!.status).toBe(429)
    expect(last!.headers.get("cache-control")).toBe("no-store")
  })

  test("the sign-in server's token endpoint answers 429 past 120 requests a minute per client and IP", async () => {
    const send = (ip: string) =>
      app.request(`${OIDC_ISSUER}/oidc/token`, {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip},
        body: "grant_type=authorization_code&code=nope&client_id=admin-portal",
      })
    const statuses = []
    for (let i = 0; i < 121; i++) statuses.push((await send("192.0.2.45")).status)
    expect(statuses.slice(0, 120).every(status => status !== 429)).toBe(true)
    expect(statuses[120]).toBe(429)
    // Another caller is unaffected.
    expect((await send("192.0.2.46")).status).not.toBe(429)
  })

  test("the request logger binds the path without its query string", async () => {
    const {Hono} = await import("../packages/core/node_modules/hono")
    const probe = new Hono<any>()
    probe.use("/api/*", requestContext)
    probe.get("/api/admin/auth/callback", c => c.json((c.var.logger as {bindings(): Record<string, unknown>}).bindings()))
    const bindings = (await (await probe.request("https://admin.test/api/admin/auth/callback?code=secret-code&state=s")).json()) as {path: string}
    expect(bindings.path).toBe("/api/admin/auth/callback")
    expect(JSON.stringify(bindings)).not.toContain("secret-code")
  })
})

describe("S02: outages fail closed", () => {
  test("a sign-in server discovery outage fails sign-in with the fixed error page and no cookie", async () => {
    resetPortalSigninCaches()
    const restore = issuerOutage("unreachable")
    try {
      const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
      expect(login.status).toBe(503)
      expect(await login.text()).toContain("Sign-in is unavailable")
      expect(login.headers.getSetCookie()).toHaveLength(0)
      expect(await LoginTransactionModel.countDocuments({})).toBe(0)
    } finally {
      restore()
    }
  })

  test("a sign-in server outage during the code exchange creates no session", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, omitTxCookie: true})
    expect(result.sessionCookie).toBeNull()
    await AuthRateLimitModel.deleteMany({})
    const restore = issuerOutage("503", ["/oidc/token"])
    try {
      const done = await app.request(result.callbackUrl.href, {headers: {cookie: `${TX_COOKIE}=${result.txCookie}`}})
      expect(done.status).toBe(503)
      expect(done.headers.getSetCookie()).toHaveLength(0)
      expect(await BrowserSessionModel.countDocuments({})).toBe(0)
    } finally {
      restore()
    }
  })

  test("a database outage at the hand-off creates no provider session or grant", async () => {
    const browser = new Browser(app)
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    const authorize = await browser.request(login.headers.get("location")!)
    const uid = new URL(authorize.headers.get("location")!, OIDC_ISSUER).pathname.split("/")[2]!
    idp.registerUser(ADMIN_PERSON)
    const token = await idp.mint({sub: ADMIN_PERSON.sub, aud: "authenticated", email: ADMIN_EMAIL})
    const sessionsBefore = await UserModel.db.db!.collection(oidcCollectionName("Session")).countDocuments({accountId: {$exists: true}})
    const grantsBefore = await UserModel.db.db!.collection(oidcCollectionName("Grant")).countDocuments({})
    await disconnectMongo()
    let handoff: Response
    try {
      handoff = await browser.request(`${OIDC_ISSUER}/interaction/${uid}/supabase`, {
        method: "POST",
        headers: {"content-type": "application/json", origin: OIDC_ISSUER},
        body: JSON.stringify({access_token: token}),
      })
    } finally {
      await connectMongo(databaseUrl)
    }
    expect(handoff.status).toBe(503)
    expect(handoff.headers.getSetCookie()).toHaveLength(0)
    assertConnectedTo(databaseUrl, UserModel.db.name)
    const db = UserModel.db.db!
    expect(await db.collection(oidcCollectionName("Session")).countDocuments({accountId: {$exists: true}})).toBe(sessionsBefore)
    expect(await db.collection(oidcCollectionName("Grant")).countDocuments({})).toBe(grantsBefore)
  })

  test("a database outage mid-flow makes the portal callback answer 503 with no Set-Cookie", async () => {
    const result = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON, omitTxCookie: true})
    await AuthRateLimitModel.deleteMany({})
    await disconnectMongo()
    try {
      const done = await app.request(result.callbackUrl.href, {headers: {cookie: `${TX_COOKIE}=${result.txCookie}`}})
      expect(done.status).toBe(503)
      expect(done.headers.getSetCookie()).toHaveLength(0)
      expect(await done.text()).toContain("Try again")
    } finally {
      await connectMongo(databaseUrl)
    }
    assertConnectedTo(databaseUrl, UserModel.db.name)
    expect(await BrowserSessionModel.countDocuments({})).toBe(0)
  })
})

describe("S01: Core's logs hold no secrets", () => {
  test("a full sign-in through Core's sign-in server, a bearer request, a refresh and sign-out leave no secret in the logs", async () => {
    const served = await startFakeIdpServer({hs256Secret: "log-redaction-supabase-jwt-secret-value"})
    served.registerUser({sub: "supa-logs", email: ADMIN_EMAIL, emailConfirmed: true})
    const supabaseIssuer = served.issuer
    const project = supabaseIssuer.replace(/\/auth\/v1$/, "")
    const port = await freePort()
    const issuer = `http://127.0.0.1:${port}`
    const keys = coreKeyEnv()
    const secrets = {
      admin: "admin-portal-client-secret-value-0123456789",
      console: "console-client-secret-value-0123456789abcd",
      cookie: "oidc-cookie-key-value-for-log-redaction-0123",
    }
    const coreDatabase = localTestMongoUrl("signin-security-logs")
    const output: string[] = []
    const core = Bun.spawn([process.execPath, "packages/core/src/index.ts"], {
      cwd: CLOUD_V2,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PORT: String(port),
        MONGO_URL: coreDatabase,
        LOG_STDOUT_JSON: "true",
        LOG_LEVEL: "trace",
        ...keys,
        SUPABASE_URL: project,
        SUPABASE_JWT_SECRET: "log-redaction-supabase-jwt-secret-value",
        SUPABASE_ANON_KEY: "sb_publishable_log_redaction_value",
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_log_redaction_value",
        CLOUD_CORE_SUPABASE_ISSUER: supabaseIssuer,
        CLOUD_CORE_OIDC_ISSUER: issuer,
        CLOUD_CORE_OIDC_COOKIE_KEYS: secrets.cookie,
        CLOUD_CORE_OIDC_CLIENTS: JSON.stringify([
          {clientId: "admin-portal", kind: "admin_portal", secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET", redirectUris: ["http://localhost:53998/api/admin/auth/callback"]},
          {clientId: "console", kind: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUris: ["http://127.0.0.1:53999/callback"]},
        ]),
        CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: secrets.admin,
        CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: secrets.console,
        CLOUD_CORE_ADMIN_PORTAL_URL: "http://localhost:53998",
        CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output.push(decoder.decode(chunk))
    }
    const drained = Promise.all([drain(core.stdout), drain(core.stderr)])
    const seen: string[] = []
    try {
      await listeningPort(output)
      // The browser reaches the issuer and the admin portal at Core's port.
      const browser = new Browser((url, init) => {
        const target = new URL(url)
        return fetch(`${issuer}${target.pathname}${target.search}`, init)
      })
      const login = await browser.request("http://localhost:53998/api/admin/auth/login?return_to=%2F")
      expect(login.status).toBe(302)
      const tx = cookieValue(login, "mentra_client_tx")!
      const authorize = await browser.request(login.headers.get("location")!)
      const interaction = new URL(authorize.headers.get("location")!, issuer)
      const uid = interaction.pathname.split("/")[2]!
      const session = served.startSession("supa-logs", null)
      const handedOff = await served.mint({
        sub: "supa-logs",
        aud: "authenticated",
        email: ADMIN_EMAIL,
        session_id: session.sessionId,
        amr: [{method: "password", timestamp: session.startedAt}],
      })
      const handoff = await browser.request(`${issuer}/interaction/${uid}/supabase`, {
        method: "POST",
        headers: {"content-type": "application/json", origin: issuer},
        body: JSON.stringify({access_token: handedOff}),
      })
      expect(handoff.status).toBe(200)
      const {redirectTo} = (await handoff.json()) as {redirectTo: string}
      const toPortal = await browser.follow(redirectTo, location => location.origin === "http://localhost:53998")
      if (!("stoppedAt" in toPortal)) throw new Error("no redirect to the portal")
      const callback = toPortal.stoppedAt
      const done = await browser.request(callback.href)
      expect(done.status).toBe(302)
      const portalSession = cookieValue(done, "mentra_admin_session")!
      expect(portalSession).toBeTruthy()
      // A replayed callback (refused).
      await fetch(`${issuer}${callback.pathname}${callback.search}`, {headers: {cookie: `mentra_client_tx=${tx}`}, redirect: "manual"})
      expect((await browser.request("http://localhost:53998/api/admin/me")).status).toBe(200)

      // The Console's sign-in from the same provider session, its bearer request and a refresh.
      const consoleConfig = await client.discovery(new URL(issuer), "console", {client_secret: secrets.console, id_token_signed_response_alg: "EdDSA"}, client.ClientSecretPost(secrets.console), {execute: [client.allowInsecureRequests]})
      const verifier = client.randomPKCECodeVerifier()
      const consoleAuthorize = client.buildAuthorizationUrl(consoleConfig, {redirect_uri: "http://127.0.0.1:53999/callback", scope: "openid email profile", code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state: "s"})
      const toConsole = await browser.follow(consoleAuthorize.href, location => location.port === "53999")
      if (!("stoppedAt" in toConsole)) throw new Error("no redirect to the Console")
      const tokens = await client.authorizationCodeGrant(consoleConfig, toConsole.stoppedAt, {pkceCodeVerifier: verifier, expectedState: "s"})
      expect((await fetch(`${issuer}/api/admin/me`, {headers: {authorization: `Bearer ${tokens.access_token}`}})).status).toBe(200)
      const refreshed = await client.refreshTokenGrant(consoleConfig, tokens.refresh_token!)
      const logout = await browser.request("http://localhost:53998/api/admin/auth/logout", {method: "POST", headers: {origin: "http://localhost:53998"}})
      expect(logout.status).toBe(200)

      const providerCookies = [...browser.cookies(issuer).values()].map(cookie => cookie.value)
      seen.push(
        callback.searchParams.get("code")!,
        toConsole.stoppedAt.searchParams.get("code")!,
        handedOff,
        tokens.access_token,
        tokens.id_token!,
        tokens.refresh_token!,
        refreshed.access_token,
        refreshed.refresh_token!,
        portalSession,
        tx,
        ...providerCookies,
        secrets.admin,
        secrets.console,
        secrets.cookie,
        "log-redaction-supabase-jwt-secret-value",
        "sb_secret_log_redaction_value",
        "sb_publishable_log_redaction_value",
      )

      core.kill()
      await core.exited
      await drained
      const logs = output.join("")
      expect(logs).toContain("signed in through the sign-in page")
      expect(logs).toContain("portal sign-in")
      for (const secret of seen) {
        expect(secret.length).toBeGreaterThan(8)
        expect(logs.includes(secret)).toBe(false)
      }
    } finally {
      if (core.exitCode === null) core.kill()
      await core.exited
      served.restore()
      await dropDatabase(coreDatabase)
    }
  })
})

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address() as {port: number}
      server.close(() => resolvePort(port))
    })
  })
}

async function listeningPort(output: string[]): Promise<number> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const line of output.join("").split("\n")) {
      if (!line.includes("core listening")) continue
      try {
        const port = (JSON.parse(line) as {port?: number}).port
        if (port) return port
      } catch {
        // not a complete JSON line yet
      }
    }
    await Bun.sleep(100)
  }
  throw new Error(`Core did not start:\n${output.join("").slice(-4000)}`)
}

async function dropDatabase(url: string): Promise<void> {
  // The subprocess's database: drop it through this process's connection to the same server.
  const name = new URL(url).pathname.slice(1)
  if (!name.startsWith("signin-security-logs-")) throw new Error(`refusing to drop ${name}`)
  await UserModel.db.getClient().db(name).dropDatabase()
}
