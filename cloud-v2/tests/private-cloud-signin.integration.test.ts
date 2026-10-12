/**
 * @fileoverview A Mentra Private Cloud's admin portal, end to end on one host
 * (L03, Review Focus 4).
 *
 * Starts a real Core (`startCore`) with one host for Core and the admin
 * portal, a fake Entra provider (fetch interception), no Supabase settings and
 * no WorkOS settings. An Entra admin on the allowlist signs in through Core's
 * own routes and gets the same Core user as their phone (`oid`); Core serves
 * the admin portal's files and never answers `/api/*` with them; the admin
 * session cookie does not authenticate the enterprise portal API.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database, ignores
 * `MONGO_URL`); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/private-cloud-signin.integration.test.ts`
 */

import crypto from "node:crypto"
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {afterAll, beforeAll, describe, expect, setDefaultTimeout, test} from "bun:test"
import {startCore, type CoreHandle} from "../packages/core/src/index"
import {UserModel} from "../packages/core/src/models/user.model"
import {resetSigningKeyCache} from "../packages/core/src/services/signing-keys.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {
  ADMIN_COOKIE,
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  cookieValue,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  PORTAL_COOKIE,
  PRIVATE_CLOUD_ENV,
  TX_COOKIE,
} from "./support/signin-harness"

setDefaultTimeout(60_000)

const CORE_HOST = "https://core.private.test"
const databaseUrl = localTestMongoUrl("private-cloud-signin")
let core: CoreHandle
let entra: FakeIdp
let staticDir: string
let restoreEnv: () => void = () => {}
let verified = false

function strip(pem: string) {
  return pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")
}

beforeAll(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "admin-dist-"))
  await mkdir(join(staticDir, "assets"), {recursive: true})
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Mentra Admin</title><script src=\"/chunk-1a2b3c4d.js\"></script>")
  await writeFile(join(staticDir, "chunk-1a2b3c4d.js"), "console.log('admin')")

  const access = crypto.generateKeyPairSync("ed25519")
  restoreEnv = applyEnv({
    ...PRIVATE_CLOUD_ENV,
    CLOUD_CORE_ADMIN_PORTAL_URL: CORE_HOST,
    CLOUD_CORE_ADMIN_STATIC_DIR: staticDir,
    CLOUD_CORE_ISSUER: CORE_HOST,
    WORKOS_API_KEY: undefined,
    WORKOS_CLIENT_ID: undefined,
    WORKOS_COOKIE_PASSWORD: undefined,
    MENTRA_JWT_PRIVATE_KEY: strip(access.privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_JWT_PUBLIC_KEY: strip(access.publicKey.export({type: "spki", format: "pem"}).toString()),
    REFRESH_TOKEN_PEPPER: "private-cloud-signin-pepper",
  })
  resetSigningKeyCache()
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  entra = await installFakeIdp({
    issuer: ENTRA_ISSUER,
    jwksUrl: ENTRA_JWKS,
    kind: "oidc",
    clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [`${CORE_HOST}/api/admin/auth/callback`]}],
  })
  core = await startCore({port: 0, mongoUrl: databaseUrl})
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await core?.stop()
  entra?.restore()
  restoreEnv()
  await rm(staticDir, {recursive: true, force: true})
})

const coreRequest = (path: string, init?: RequestInit) => fetch(`${core.url}${path}`, {redirect: "manual", ...init})

async function signIn(person: {sub: string; email: string; claims: Record<string, unknown>}) {
  const login = await coreRequest("/api/admin/auth/login?return_to=%2F%3Freport%3Drep_1")
  expect(login.status).toBe(302)
  const tx = cookieValue(login, TX_COOKIE)!
  const callback = await entra.approve(login.headers.get("location")!, person)
  expect(callback.origin).toBe(CORE_HOST)
  const done = await coreRequest(`${callback.pathname}${callback.search}`, {headers: {cookie: `${TX_COOKIE}=${tx}`}})
  return {done, session: cookieValue(done, ADMIN_COOKIE)}
}

describe("a Private Cloud admin portal on Core's host", () => {
  test("an Entra admin on the allowlist signs in with the phone's Core user and gets organization capabilities (L03)", async () => {
    const phoneUser = await findOrCreateUser({tenantId: "contoso", tenantUserId: "entra-oid-admin"})
    const {done, session} = await signIn({sub: "pairwise-sub", email: "it-admin@contoso.com", claims: {oid: "entra-oid-admin", tid: ENTRA_TENANT}})
    expect(done.status).toBe(302)
    expect(done.headers.get("location")).toBe("/?report=rep_1")
    const me = await coreRequest("/api/admin/me", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})
    expect(me.status).toBe(200)
    const body = (await me.json()) as {admin: boolean; principal: {mentraUserId: string; email: string; emailVerified: boolean}}
    expect(body.admin).toBe(true)
    expect(body.principal).toMatchObject({mentraUserId: phoneUser.mentraUserId, email: "it-admin@contoso.com", emailVerified: true})
    // Incident triage is an Organization Admin capability.
    expect((await coreRequest("/api/admin/reports", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})).status).toBe(200)
  })

  test("the admin session cookie does not authenticate the enterprise portal API", async () => {
    const {session} = await signIn({sub: "pairwise-2", email: "it-admin@contoso.com", claims: {oid: "entra-oid-admin", tid: ENTRA_TENANT}})
    expect((await coreRequest("/api/portal/me", {headers: {cookie: `${ADMIN_COOKIE}=${session}`}})).status).toBe(401)
    expect((await coreRequest("/api/portal/me", {headers: {cookie: `${PORTAL_COOKIE}=${session}`}})).status).toBe(401)
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

  test("/api/* and /.well-known/* are never answered by the static handler", async () => {
    for (const path of ["/api/does-not-exist", "/api/admin/nope/../../x", "/.well-known/nothing"]) {
      const response = await coreRequest(path)
      expect(await response.text()).not.toContain("Mentra Admin")
    }
    // Core's own JWKS route answers, not the admin app (its status depends on the signing keys configured here).
    const jwks = await coreRequest("/.well-known/jwks.json")
    expect(jwks.headers.get("content-type")).toContain("application/json")
    expect(await jwks.text()).not.toContain("Mentra Admin")
  })

  test("a path outside the admin build is never served", async () => {
    const response = await coreRequest("/..%2f..%2fetc%2fpasswd")
    expect(await response.text()).not.toContain("root:")
  })
})
