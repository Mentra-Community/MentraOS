/**
 * @fileoverview Security sweep for Core's portal sign-in (S01, S02).
 *
 * S01: every response from `/api/{admin,portal}/auth/*` is `no-store`, the
 * login and callback limits answer 429, and a full sign-in, bearer request and
 * sign-out leave no authorization code, token, client secret, signing secret
 * or cookie value in Core's logs. The log check runs Core as its own process
 * (JSON logs at trace level, captured from stdout and stderr) against a fake
 * Supabase served on 127.0.0.1.
 *
 * S02: an identity provider discovery outage, a key set outage and a database
 * outage mid-flow all fail closed: a fixed error page or 503, no session, no
 * `Set-Cookie`.
 *
 * Safety: `localTestMongoUrl` (loopback only, random databases, ignores
 * `MONGO_URL`); the databases are dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/signin-security.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"
import {resolve} from "node:path"

import {createApp} from "../packages/core/src/api/app"
import {requestContext} from "../packages/core/src/api/middleware/context.middleware"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {LoginTransactionModel} from "../packages/core/src/models/login-transaction.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {installFakeIdp, startFakeIdpServer, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  cookieValue,
  HOSTED_ENV,
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
const ADMIN_PERSON = {sub: "supa-security", email: ADMIN_EMAIL, emailConfirmed: true}
const MODELS = [UserModel, BrowserSessionModel, LoginTransactionModel, AuthRateLimitModel]

beforeAll(async () => {
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.syncIndexes()))
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
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

describe("S01: auth responses are no-store", () => {
  test("login, callback, error pages and logout on both portals", async () => {
    const responses: Response[] = []
    for (const [portal, origin] of [["admin", ADMIN_ORIGIN], ["portal", "https://portal.test"]] as const) {
      responses.push(await app.request(`${origin}/api/${portal}/auth/login`))
      responses.push(await app.request(`${origin}/api/${portal}/auth/callback?code=x&state=y`))
      responses.push(await app.request(`${origin}/api/${portal}/auth/logout`, {method: "POST", headers: {origin}}))
      responses.push(await app.request(`${origin}/api/${portal}/auth/logout`, {method: "POST", headers: {origin: "https://evil.example"}}))
    }
    const success = await portalSignIn(app, idp, {portal: "admin", person: ADMIN_PERSON})
    responses.push(success.login, success.done)
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("a not-configured portal answers no-store too", async () => {
    const restore = applyEnv({CLOUD_CORE_SUPABASE_ISSUER: undefined})
    try {
      const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
      expect(login.status).toBe(503)
      expect(login.headers.get("cache-control")).toBe("no-store")
    } finally {
      restore()
    }
  })

  test("the login and callback limits answer 429", async () => {
    const ip = {"x-forwarded-for": "192.0.2.44"}
    let last: Response | undefined
    for (let i = 0; i < 21; i++) last = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`, {headers: ip})
    expect(last!.status).toBe(429)
    for (let i = 0; i < 31; i++) last = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/callback?code=c&state=s`, {headers: ip})
    expect(last!.status).toBe(429)
    expect(last!.headers.get("cache-control")).toBe("no-store")
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
  test("a discovery outage fails sign-in with the fixed error page and no cookie", async () => {
    idp.outage = true
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    expect(login.status).toBe(503)
    expect(await login.text()).toContain("Sign-in is unavailable")
    expect(login.headers.getSetCookie()).toHaveLength(0)
    expect(await LoginTransactionModel.countDocuments({})).toBe(0)
  })

  test("an identity provider outage during the code exchange creates no session", async () => {
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    const tx = cookieValue(login, TX_COOKIE)!
    const callback = await idp.approve(login.headers.get("location")!, ADMIN_PERSON)
    idp.outage = true
    const done = await app.request(callback.href, {headers: {cookie: `${TX_COOKIE}=${tx}`}})
    expect(done.status).toBe(503)
    expect(done.headers.getSetCookie()).toHaveLength(0)
    expect(await BrowserSessionModel.countDocuments({})).toBe(0)
  })

  test("a key set outage makes identity-provider bearers fail with 503, never succeed", async () => {
    const token = await idp.mint({sub: "supa-security", aud: "authenticated", client_id: "admin-client"}, {alg: "ES256"})
    idp.outage = true
    const response = await app.request(`${ADMIN_ORIGIN}/api/admin/me`, {headers: {authorization: `Bearer ${token}`}})
    expect(response.status).toBe(503)
  })

  test("a database outage mid-flow makes the callback answer 503 with no Set-Cookie", async () => {
    const login = await app.request(`${ADMIN_ORIGIN}/api/admin/auth/login`)
    const tx = cookieValue(login, TX_COOKIE)!
    const callback = await idp.approve(login.headers.get("location")!, ADMIN_PERSON)
    await disconnectMongo()
    try {
      const done = await app.request(callback.href, {headers: {cookie: `${TX_COOKIE}=${tx}`}})
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
  test("a full sign-in, a bearer request and sign-out leave no code, token, secret or cookie value in the logs", async () => {
    const served = await startFakeIdpServer({
      hs256Secret: "log-redaction-supabase-jwt-secret-value",
      clients: [{id: "admin-client", secret: "admin-client-secret-value", redirectUris: ["http://admin.localtest/api/admin/auth/callback"]}],
    })
    served.registerUser({sub: "supa-logs", email: ADMIN_EMAIL, emailConfirmed: true})
    const issuer = served.issuer
    const project = issuer.replace(/\/auth\/v1$/, "")
    const coreDatabase = localTestMongoUrl("signin-security-logs")
    const output: string[] = []
    const core = Bun.spawn(["bun", "packages/core/src/index.ts"], {
      cwd: CLOUD_V2,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PORT: "0",
        MONGO_URL: coreDatabase,
        LOG_STDOUT_JSON: "true",
        LOG_LEVEL: "trace",
        SUPABASE_URL: project,
        SUPABASE_JWT_SECRET: "log-redaction-supabase-jwt-secret-value",
        SUPABASE_ANON_KEY: "sb_publishable_log_redaction_value",
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_log_redaction_value",
        CLOUD_CORE_SUPABASE_ISSUER: issuer,
        CLOUD_CORE_WEB_CLIENT_IDS: "admin-client",
        CLOUD_CORE_ADMIN_PORTAL_URL: "http://admin.localtest",
        CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID: "admin-client",
        CLOUD_CORE_ADMIN_PORTAL_CLIENT_SECRET: "admin-client-secret-value",
        CLOUD_CORE_IDP_SIGNOUT_URL: "http://account.localtest/signout",
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
    try {
      const port = await listeningPort(output)
      const base = `http://127.0.0.1:${port}`
      const login = await fetch(`${base}/api/admin/auth/login?return_to=%2F`, {redirect: "manual"})
      expect(login.status).toBe(302)
      const tx = cookieValue(login, "mentra_client_tx")!
      const callback = await served.approve(login.headers.get("location")!, {sub: "supa-logs", email: ADMIN_EMAIL})
      const done = await fetch(`${base}${callback.pathname}${callback.search}`, {headers: {cookie: `mentra_client_tx=${tx}`}, redirect: "manual"})
      expect(done.status).toBe(302)
      const session = cookieValue(done, "mentra_admin_session")!
      expect(session).toBeTruthy()
      // A replayed callback (refused) and a request with a bad code.
      await fetch(`${base}${callback.pathname}${callback.search}`, {headers: {cookie: `mentra_client_tx=${tx}`}, redirect: "manual"})
      const me = await fetch(`${base}/api/admin/me`, {headers: {cookie: `mentra_admin_session=${session}`}})
      expect(me.status).toBe(200)
      const bearer = await served.mint({sub: "supa-logs", aud: "authenticated", client_id: "admin-client", email: ADMIN_EMAIL})
      expect((await fetch(`${base}/api/admin/me`, {headers: {authorization: `Bearer ${bearer}`}})).status).toBe(200)
      const logout = await fetch(`${base}/api/admin/auth/logout`, {method: "POST", headers: {cookie: `mentra_admin_session=${session}`, origin: "http://admin.localtest"}})
      expect(logout.status).toBe(200)

      core.kill()
      await core.exited
      await drained
      const logs = output.join("")
      expect(logs).toContain("portal sign-in")
      const secrets = [
        ...served.issuedSecrets,
        bearer,
        session,
        tx,
        "admin-client-secret-value",
        "log-redaction-supabase-jwt-secret-value",
        "sb_secret_log_redaction_value",
        "sb_publishable_log_redaction_value",
        callback.searchParams.get("code")!,
      ]
      for (const secret of secrets) {
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
