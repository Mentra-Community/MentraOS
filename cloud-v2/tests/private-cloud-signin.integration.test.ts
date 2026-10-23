/**
 * @fileoverview A Mentra Private Cloud's admin portal, end to end on one host
 * (L03, L05, Review Focus 4).
 *
 * Starts a real Core (`startCore`) with one host for Core, its sign-in server
 * (the issuer) and the admin portal, a fake Entra provider (fetch
 * interception) and no Supabase settings. An Entra admin
 * on the allowlist signs in to the admin portal through Core's sign-in server,
 * which fronts Entra, and gets the same Core user as their phone (`oid`).
 * Core serves the admin portal's files and never answers `/api/*`, `/oidc/*`
 * or `/interaction/*` with them; neither the admin session cookie nor the
 * sign-in server's cookies authenticate another route group.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/private-cloud-signin.integration.test.ts`
 */

import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {afterAll, beforeAll, describe, expect, setDefaultTimeout, test} from "bun:test"
import {startCore, type CoreHandle} from "../packages/core/src/index"
import {UserModel} from "../packages/core/src/models/user.model"
import {resetUpstreamCaches} from "../packages/core/src/services/oidc/upstream"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {Browser, CLIENT_SECRETS} from "./support/oidc-harness"
import {
  ADMIN_COOKIE,
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  PORTAL_COOKIE,
  PRIVATE_CLOUD_ENV,
} from "./support/signin-harness"

setDefaultTimeout(60_000)

const CORE_HOST = "https://core.private.test"
const databaseUrl = localTestMongoUrl("private-cloud-signin")
let core: CoreHandle
let entra: FakeIdp
let staticDir: string
let restoreEnv: () => void = () => {}
let restoreFetch: () => void = () => {}
let verified = false

beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "admin-dist-"))
  await mkdir(join(staticDir, "assets"), {recursive: true})
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Mentra Admin</title><script src=\"/chunk-1a2b3c4d.js\"></script>")
  await writeFile(join(staticDir, "chunk-1a2b3c4d.js"), "console.log('admin')")

  restoreEnv = applyEnv({
    ...PRIVATE_CLOUD_ENV,
    // Core, its sign-in server and the admin portal share Core's one host.
    CLOUD_CORE_ISSUER: CORE_HOST,
    CLOUD_CORE_OIDC_ISSUER: CORE_HOST,
    CLOUD_CORE_ADMIN_PORTAL_URL: CORE_HOST,
    CLOUD_CORE_OIDC_CLIENTS: JSON.stringify([
      {
        clientId: "admin-portal",
        kind: "admin_portal",
        secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
        redirectUris: [`${CORE_HOST}/api/admin/auth/callback`],
      },
    ]),
    CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: CLIENT_SECRETS.CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET,
    CLOUD_CORE_ADMIN_STATIC_DIR: staticDir,
    REFRESH_TOKEN_PEPPER: "private-cloud-signin-pepper",
  })
  resetCoreKeyCaches()
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  resetUpstreamCaches()
  entra = await installFakeIdp({
    issuer: ENTRA_ISSUER,
    jwksUrl: ENTRA_JWKS,
    kind: "oidc",
    clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [`${CORE_HOST}/interaction/callback/workforce`]}],
  })
  core = await startCore({port: 0, mongoUrl: databaseUrl})
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  // Core's own calls to its issuer (the portal's discovery and code exchange) reach this Core over HTTP.
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.origin === CORE_HOST) return inner(new Request(`${core.url}${url.pathname}${url.search}`, request))
    return inner(input as RequestInfo, init)
  }) as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = inner
  }
})

afterAll(async () => {
  restoreFetch()
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await core?.stop()
  entra?.restore()
  restoreEnv()
  resetCoreKeyCaches()
  await rm(staticDir, {recursive: true, force: true})
})

/** A browser on Core's one host. */
const browserOnCore = () => new Browser((url, init) => fetch(url, init))
const coreRequest = (path: string, init?: RequestInit) => fetch(`${CORE_HOST}${path}`, {redirect: "manual", ...init})

async function signIn(person: {sub: string; email: string; claims: Record<string, unknown>}) {
  const browser = browserOnCore()
  const login = await browser.request(`${CORE_HOST}/api/admin/auth/login?return_to=%2F%3Freport%3Drep_1`)
  expect(login.status).toBe(302)
  const authorize = new URL(login.headers.get("location")!)
  expect(authorize.origin).toBe(CORE_HOST)
  const step = await browser.follow(authorize.href, location => location.origin === new URL(ENTRA_ISSUER).origin)
  if (!("stoppedAt" in step)) throw new Error("no redirect to Entra")
  const back = await entra.approve(step.stoppedAt, person)
  expect(back.origin).toBe(CORE_HOST)
  const toPortal = await browser.follow(back.href, location => location.pathname === "/api/admin/auth/callback")
  if (!("stoppedAt" in toPortal)) throw new Error("no redirect to the portal")
  const done = await browser.request(toPortal.stoppedAt)
  return {done, session: browser.cookies(CORE_HOST).get(ADMIN_COOKIE)?.value ?? null, browser}
}

describe("a Private Cloud admin portal on Core's host", () => {
  test("discovery is served on Core's host, which is the issuer", async () => {
    const discovery = (await (await coreRequest("/.well-known/openid-configuration")).json()) as {issuer: string; authorization_endpoint: string}
    expect(discovery.issuer).toBe(CORE_HOST)
    expect(discovery.authorization_endpoint).toBe(`${CORE_HOST}/oidc/auth`)
  })

  test("an Entra admin on the allowlist signs in through Core's sign-in server with the phone's Core user and gets organization capabilities (L03)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "entra-oid-admin"})
    const {done, session} = await signIn({sub: "pairwise-sub", email: "it-admin@contoso.com", claims: {oid: "entra-oid-admin", tid: ENTRA_TENANT}})
    expect(done.status).toBe(302)
    expect(done.headers.get("location")).toBe("/?report=rep_1")
    const me = await coreRequest("/api/admin/me", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})
    expect(me.status).toBe(200)
    const body = (await me.json()) as {user: {mentraUserId: string; email: string; emailVerified: boolean; isOrganizationAdmin: boolean}; organization: {capabilities: string[]}}
    expect(body.user).toMatchObject({mentraUserId: phoneUser.mentraUserId, email: "it-admin@contoso.com", emailVerified: true, isOrganizationAdmin: true})
    expect(body.organization.capabilities).toContain("organization.workspaces.administer")
    expect((await coreRequest("/api/admin/reports", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})).status).toBe(200)
  })

  test("neither the admin session cookie nor the sign-in server's cookies authenticate another route group (Review Focus 4)", async () => {
    const {session, browser} = await signIn({sub: "pairwise-2", email: "it-admin@contoso.com", claims: {oid: "entra-oid-admin", tid: ENTRA_TENANT}})
    expect((await coreRequest("/api/portal/me", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})).status).toBe(401)
    expect((await coreRequest("/api/portal/me", {headers: {cookie: `${PORTAL_COOKIE}=${session}`}})).status).toBe(401)
    const providerCookies = [...browser.cookies(CORE_HOST)].filter(([name]) => name.includes("oidc")).map(([name, cookie]) => `${name}=${cookie.value}`)
    expect(providerCookies.length).toBeGreaterThan(0)
    for (const path of ["/api/admin/me", "/api/portal/me", "/api/workspaces"]) {
      expect((await coreRequest(path, {headers: {cookie: providerCookies.join("; ")}})).status).toBe(401)
    }
  })

  test("the admin portal's files are served, with an SPA fallback and the admin CSP", async () => {
    const index = await coreRequest("/")
    expect(index.status).toBe(200)
    expect(await index.text()).toContain("Mentra Admin")
    expect(index.headers.get("cache-control")).toBe("no-cache")
    expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    const deepLink = await coreRequest("/reports/rep_1")
    expect(deepLink.status).toBe(200)
    expect(await deepLink.text()).toContain("Mentra Admin")
    const asset = await coreRequest("/chunk-1a2b3c4d.js")
    expect(asset.headers.get("cache-control")).toContain("immutable")
    expect(await asset.text()).toContain("admin")
  })

  test("/api/*, /.well-known/*, /oidc/* and /interaction/* are never answered by the static handler", async () => {
    for (const path of ["/api/does-not-exist", "/api/admin/nope/../../x", "/.well-known/nothing", "/oidc/nothing", "/interaction/nothing"]) {
      const response = await coreRequest(path)
      expect(await response.text()).not.toContain("Mentra Admin")
    }
    const jwks = await coreRequest("/.well-known/jwks.json")
    expect(jwks.headers.get("content-type")).toContain("application/json")
    expect(await jwks.text()).not.toContain("Mentra Admin")
  })

  test("a path outside the admin build is never served", async () => {
    const response = await coreRequest("/..%2f..%2fetc%2fpasswd")
    expect(await response.text()).not.toContain("root:")
  })
})
