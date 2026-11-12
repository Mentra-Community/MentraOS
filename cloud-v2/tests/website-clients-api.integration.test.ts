/**
 * @fileoverview Registering miniapp websites: the admin portal's `/api/admin/website-clients` and the Store's
 * signed `/api/internal/website-clients` for a developer's own
 * (`design_docs/cloud/auth/miniapp-website-sign-in/spec.md`, W03 and W04).
 *
 * Both run through the real app with the real principal and service middleware. What must hold:
 *  - an Organization Admin who is a person registers, changes and removes any website; everyone else is
 *    refused there;
 *  - through the Store, a person registers a website only for a package in Core's registry, and only with
 *    redirect URIs on that package's own domain, with their own Core access token: the Store's signature
 *    alone registers nothing;
 *  - its name is the miniapp's, as Core verified it, never one the developer typed;
 *  - a person sees and changes only the websites they registered;
 *  - production clients take HTTPS redirects only; a development client redirects to the developer's computer;
 *  - a secret is answered once, stored only as a hash, and every write is audited.
 *
 * Safety: `localTestMongoUrl` (loopback only, random database); the database is dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/website-clients-api.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {MiniappRegistryArchiveRuleModel, MiniappRegistryEntryModel} from "../packages/core/src/models/miniapp-registry.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WebsiteClientModel} from "../packages/core/src/models/website-client.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {findClient} from "../packages/core/src/services/oidc/clients"
import {hashWebsiteClientSecret, MAX_WEBSITES_PER_DEVELOPER} from "../packages/core/src/services/oidc/website-clients.service"
import {archive} from "../packages/core/src/services/registry/registry.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {SERVICE_HEADERS, signServiceRequest} from "../packages/workspace-contract/src/server"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {ADMIN_COOKIE, ADMIN_EMAIL, ADMIN_ORIGIN, applyEnv, coreAccessToken, HOSTED_ENV} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [AdminActionAuditLogModel, AuthRateLimitModel, BrowserSessionModel, MiniappRegistryArchiveRuleModel, MiniappRegistryEntryModel, SigninIdentityModel, UserModel, WebsiteClientModel, WorkspaceMembershipModel, WorkspaceModel]
const ADMIN = "/api/admin/website-clients"
const STORE = "/api/internal/website-clients"
const PAPERWORK = "com.mentra.paperwork"

const databaseUrl = localTestMongoUrl("website-clients-api")
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}

beforeAll(async () => {
  restoreEnv = applyEnv({
    ...HOSTED_ENV,
    CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
    CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
    CLOUD_CORE_SERVICE_SECRETS: JSON.stringify({store: ["store-s1"], fleet: ["fleet-f1"]}),
    REFRESH_TOKEN_PEPPER: "website-clients-pepper",
  })
  resetCoreKeyCaches()
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await disconnectMongo()
  restoreEnv()
  resetCoreKeyCaches()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
})

interface Person {
  mentraUserId: string
  email: string
  token: string
}

let people = 0
async function person(email?: string): Promise<Person> {
  const sub = `supa-wc-${++people}`
  const address = email ?? `wc${people}@example.test`
  const token = await coreAccessToken({sub, email: address, emailVerified: true})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {mentraUserId, email: address, token}
}

async function workspace(workspaceId: string, members: Array<[Person, string]>) {
  await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
  for (const [who, role] of members) {
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: `wm_${workspaceId}_${who.mentraUserId}`, workspaceId, mentraUserId: who.mentraUserId, role, status: "active", startedAt: new Date()}),
    )
  }
}

async function admin(method: string, path: string, as: Person | null, body?: unknown) {
  const headers: Record<string, string> = {}
  if (as) headers.authorization = `Bearer ${as.token}`
  if (body !== undefined) headers["content-type"] = "application/json"
  const response = await app.request(`${ADMIN_ORIGIN}${ADMIN}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)})
  const text = await response.text()
  return {status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers}
}

async function store(route: string, body: unknown, opts: {service?: "store" | "fleet"; secret?: string; unsigned?: boolean} = {}) {
  const path = `${STORE}${route}`
  const text = JSON.stringify(body)
  const timestampMs = Date.now()
  const service = opts.service ?? "store"
  const headers: Record<string, string> = {"content-type": "application/json"}
  if (!opts.unsigned) {
    headers[SERVICE_HEADERS.service] = service
    headers[SERVICE_HEADERS.timestamp] = String(timestampMs)
    headers[SERVICE_HEADERS.signature] = signServiceRequest({
      secret: opts.secret ?? (service === "fleet" ? "fleet-f1" : "store-s1"),
      method: "POST",
      pathWithQuery: path,
      body: text,
      timestampMs,
    })
  }
  const response = await app.request(`https://core.test${path}`, {method: "POST", headers, body: text})
  const answer = await response.text()
  return {status: response.status, json: answer ? JSON.parse(answer) : null, headers: response.headers}
}

const site = (overrides: Record<string, unknown> = {}) => ({
  name: "Paperwork",
  type: "server",
  environment: "production",
  redirectUris: ["https://paperwork.example.com/auth/callback"],
  packageName: PAPERWORK,
  access: "public",
  ...overrides,
})

describe("the admin portal", () => {
  test("an Organization Admin registers a website, sees it, changes it, replaces its secret and removes it", async () => {
    const orgAdmin = await person(ADMIN_EMAIL)

    const created = await admin("POST", "", orgAdmin, site())
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const {client, secret} = created.json
    expect(client).toMatchObject({name: "Paperwork", type: "server", environment: "production", packageName: PAPERWORK, ownerUserId: null, access: "public", status: "active"})
    expect(client.clientId).toMatch(/^mwc_[0-9a-z]{26}$/)
    expect(secret).toMatch(/^mws_[A-Za-z0-9_-]{43}$/)
    expect(client.secretLast4).toBe(secret.slice(-4))

    // Only the hash is stored, and no answer after the first carries the secret.
    const stored = await WebsiteClientModel.findOne({clientId: client.clientId}).lean()
    expect(stored!.secretHash).toBe(hashWebsiteClientSecret(secret))
    const listed = await admin("GET", "", orgAdmin)
    expect(listed.json.clients).toHaveLength(1)
    expect(JSON.stringify(listed.json)).not.toContain(secret)
    expect(JSON.stringify(listed.json)).not.toContain(stored!.secretHash!)

    // The sign-in server knows it at once, as a third-party client of that package.
    expect(await findClient(client.clientId)).toMatchObject({firstParty: false, confidential: true, website: {packageName: PAPERWORK}})

    const changed = await admin("PATCH", `/${client.clientId}`, orgAdmin, {name: "Paperwork Web", redirectUris: ["https://paperwork.example.com/cb"], status: "disabled"})
    expect(changed.json.client).toMatchObject({name: "Paperwork Web", redirectUris: ["https://paperwork.example.com/cb"], status: "disabled"})
    // A disabled client is no client to the sign-in server.
    expect(await findClient(client.clientId)).toBeNull()

    const regenerated = await admin("POST", `/${client.clientId}/secret`, orgAdmin)
    expect(regenerated.status).toBe(200)
    expect(regenerated.json.secret).not.toBe(secret)
    expect((await WebsiteClientModel.findOne({clientId: client.clientId}).lean())!.secretHash).toBe(hashWebsiteClientSecret(regenerated.json.secret))

    expect((await admin("DELETE", `/${client.clientId}`, orgAdmin)).status).toBe(204)
    expect((await admin("GET", "", orgAdmin)).json.clients).toEqual([])
    expect((await admin("DELETE", `/${client.clientId}`, orgAdmin)).status).toBe(404)

    // Every write is in the audit log under the admin's email, without the secret.
    const audit = await AdminActionAuditLogModel.find({targetId: client.clientId}).sort({createdAt: 1}).lean()
    expect(audit.map(row => row.action)).toEqual(["website_client.create", "website_client.update", "website_client.regenerate_secret", "website_client.delete"])
    expect(new Set(audit.map(row => row.adminId))).toEqual(new Set([ADMIN_EMAIL]))
    expect(JSON.stringify(audit)).not.toContain(secret)
    expect(JSON.stringify(audit)).not.toContain(regenerated.json.secret)
  })

  test("the admin portal's own session works for every method, from the portal's origin only", async () => {
    const orgAdmin = await person(ADMIN_EMAIL)
    const {cookieValue} = await createPortalSession("admin", {
      mentraUserId: orgAdmin.mentraUserId,
      tenantId: "mentra",
      sourceId: "mentra",
      subject: "supa-session-admin",
      email: ADMIN_EMAIL,
      emailVerified: true,
      authTime: new Date(),
    })
    const call = (method: string, path: string, body?: unknown, origin: string | null = ADMIN_ORIGIN) =>
      app.request(`${ADMIN_ORIGIN}${ADMIN}${path}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${cookieValue}`,
          ...(origin ? {origin} : {}),
          ...(body === undefined ? {} : {"content-type": "application/json"}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    const created = await call("POST", "", site())
    expect(created.status).toBe(201)
    const {client} = (await created.json()) as {client: {clientId: string}}
    expect((await call("GET", "", undefined, null)).status).toBe(200)
    expect((await call("PATCH", `/${client.clientId}`, {status: "disabled"})).status).toBe(200)
    expect((await call("POST", `/${client.clientId}/secret`)).status).toBe(200)
    // Another site's page cannot write with the admin's cookie.
    for (const [method, path, body] of [["POST", "", site({packageName: "com.evil.app"})], ["PATCH", `/${client.clientId}`, {status: "active"}], ["DELETE", `/${client.clientId}`, undefined]] as const) {
      const refused = await call(method, path, body, "https://evil.test")
      expect([method, refused.status]).toEqual([method, 403])
    }
    expect((await WebsiteClientModel.findOne({clientId: client.clientId}).lean())!.status).toBe("disabled")
    expect(await WebsiteClientModel.countDocuments()).toBe(1)
    expect((await call("DELETE", `/${client.clientId}`)).status).toBe(204)
  })

  test("a browser client has no secret", async () => {
    const orgAdmin = await person(ADMIN_EMAIL)
    const created = await admin("POST", "", orgAdmin, site({type: "browser"}))
    expect(created.status).toBe(201)
    expect(created.json.secret).toBeNull()
    expect(created.json.client).toMatchObject({ownerUserId: null, secretLast4: null})
    expect((await admin("POST", `/${created.json.client.clientId}/secret`, orgAdmin)).status).toBe(400)
  })

  test("anyone but an Organization Admin is refused, and nothing is written", async () => {
    const owner = await person()
    await workspace("ws_fleet", [[owner, "owner"]])
    expect((await admin("POST", "", owner, site())).status).toBe(403)
    expect((await admin("GET", "", owner)).status).toBe(403)
    expect((await admin("GET", "", null)).status).toBe(401)
    expect([401, 403]).toContain((await admin("POST", "", null, site())).status)
    expect(await WebsiteClientModel.countDocuments()).toBe(0)
  })

  test.each([
    ["an HTTP redirect on a production client", {redirectUris: ["http://paperwork.example.com/cb"]}, "must be an HTTPS URL"],
    ["a loopback redirect on a production client", {redirectUris: ["http://127.0.0.1:5173/cb"]}, "only a development client"],
    ["a loopback redirect without a port", {environment: "development", redirectUris: ["http://localhost/cb"]}, "needs a fixed port"],
    ["a private LAN address", {environment: "development", redirectUris: ["http://192.168.1.20:5173/cb"]}, "must be an HTTPS URL"],
    ["a redirect with a fragment", {redirectUris: ["https://paperwork.example.com/cb#x"]}, "no fragment"],
    ["a redirect with credentials", {redirectUris: ["https://user:pw@paperwork.example.com/cb"]}, "no fragment or credentials"],
    ["no redirects", {redirectUris: []}, "non-empty list"],
    ["an unknown type", {type: "native"}, "type must be one of"],
    ["a name with markup", {name: "<b>Mentra</b>"}, "angle brackets"],
    ["something that is not a package name", {packageName: "Paperwork"}, "package name"],
    ["a private client with no workspaces", {access: "private"}, "accessWorkspaceIds"],
  ] as const)("refuses %s", async (_label, overrides, message) => {
    const orgAdmin = await person(ADMIN_EMAIL)
    const refused = await admin("POST", "", orgAdmin, site(overrides))
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({error: "invalid_request"})
    expect(refused.json.error_description).toContain(message)
    expect(await WebsiteClientModel.countDocuments()).toBe(0)
  })

  test("a development client takes loopback redirects on a fixed port", async () => {
    const orgAdmin = await person(ADMIN_EMAIL)
    const created = await admin("POST", "", orgAdmin, site({type: "browser", environment: "development", redirectUris: ["http://127.0.0.1:5173/callback", "http://localhost:5173/callback", "http://[::1]:5173/callback"]}))
    expect(created.status).toBe(201)
    // Changing it keeps its environment's rules.
    expect((await admin("PATCH", `/${created.json.client.clientId}`, orgAdmin, {redirectUris: ["http://127.0.0.1/callback"]})).status).toBe(400)
  })
})

describe("W04: a developer's own websites, through the Store", () => {
  const NOTES = "com.example.notes"
  let entries = 0
  /** A miniapp as an install leaves it in Core's registry: served from example.com, so named under `com.example`. */
  async function installed(packageName = NOTES, overrides: Record<string, unknown> = {}) {
    const at = new Date()
    const domain = packageName.split(".").slice(0, 2).reverse().join(".")
    await MiniappRegistryEntryModel.create({
      url: `https://app${++entries}.${domain}/`,
      packageName,
      registrableDomain: domain,
      name: "Example Notes",
      version: "1.0.0",
      ageRating: "4+",
      iconUrl: null,
      verification: "verified",
      manifest: "{}",
      private: false,
      status: "active",
      firstRegisteredAt: at,
      firstRegisteredBy: "mu_someone",
      lastVerifiedAt: at,
      lastVerifyAttemptAt: at,
      lastSeenVersion: "1.0.0",
      ...overrides,
    })
  }
  const own = (overrides: Record<string, unknown> = {}) => ({
    packageName: NOTES,
    type: "server",
    environment: "production",
    redirectUris: ["https://notes.example.com/auth/callback"],
    ...overrides,
  })

  test("a developer registers a website on their miniapp's domain, and changes, re-keys and removes it", async () => {
    await installed()
    const developer = await person()

    const created = await store("/create", {token: developer.token, client: own()})
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const {client, secret} = created.json
    // The name is the miniapp's own, as Core read it; anyone signed in to Mentra may sign in there.
    expect(client).toMatchObject({name: "Example Notes", packageName: NOTES, ownerUserId: developer.mentraUserId, access: "public", status: "active"})
    expect(secret).toMatch(/^mws_/)
    expect(await findClient(client.clientId)).toMatchObject({firstParty: false, website: {packageName: NOTES, onlyUserId: null}})

    const listed = await store("/list", {token: developer.token})
    expect(listed.json.max).toBe(MAX_WEBSITES_PER_DEVELOPER)
    expect(listed.json.clients.map((row: {clientId: string}) => row.clientId)).toEqual([client.clientId])
    expect(JSON.stringify(listed.json)).not.toContain(secret)

    const updated = await store("/update", {token: developer.token, clientId: client.clientId, changes: {redirectUris: ["https://www.example.com/cb"], status: "disabled"}})
    expect(updated.json.client).toMatchObject({redirectUris: ["https://www.example.com/cb"], status: "disabled"})
    // A change keeps to the same rule: the new address must be on the package's domain too.
    const moved = await store("/update", {token: developer.token, clientId: client.clientId, changes: {redirectUris: ["https://example.org/cb"]}})
    expect([moved.status, moved.json.error]).toEqual([422, "domain_mismatch"])

    const regenerated = await store("/regenerate-secret", {token: developer.token, clientId: client.clientId})
    expect(regenerated.json.secret).toMatch(/^mws_/)
    expect(regenerated.json.secret).not.toBe(secret)

    expect((await store("/delete", {token: developer.token, clientId: client.clientId})).json).toEqual({deleted: true})
    expect(await WebsiteClientModel.countDocuments()).toBe(0)
    const audit = await AdminActionAuditLogModel.find({targetId: client.clientId}).sort({createdAt: 1}).lean()
    expect(audit.map(row => row.action)).toEqual(["website_client.create", "website_client.update", "website_client.regenerate_secret", "website_client.delete"])
    expect(audit.every(row => row.adminId === developer.email)).toBe(true)
    expect(JSON.stringify(audit)).not.toContain(secret)
  })

  test.each([
    ["another domain", "https://notes.example.org/cb"],
    ["a look-alike domain", "https://example.com.evil.test/cb"],
    ["a domain that only ends the same", "https://notexample.com/cb"],
    ["someone's shared host", "https://example.github.io/cb"],
    ["the sign-in site itself", "https://account.mentraglass.com/cb"],
  ])("a website cannot sign people in for a miniapp from %s", async (_label, redirectUri) => {
    await installed()
    const stranger = await person()
    const refused = await store("/create", {token: stranger.token, client: own({redirectUris: [redirectUri]})})
    expect([refused.status, refused.json.error]).toEqual([422, "domain_mismatch"])
    // One good address beside a bad one does not carry it.
    const mixed = await store("/create", {token: stranger.token, client: own({redirectUris: ["https://notes.example.com/cb", redirectUri]})})
    expect(mixed.status).toBe(422)
    expect(await WebsiteClientModel.countDocuments()).toBe(0)
  })

  test("Mentra's own miniapps answer only from mentraglass.com", async () => {
    await installed("com.mentra.notes", {registrableDomain: "mentraglass.com", url: "https://miniapps.mentraglass.com/com.mentra.notes/", name: "Notes"})
    const stranger = await person()
    for (const redirectUri of ["https://mentra.com/cb", "https://notes.mentra.example.com/cb", "https://mentra.github.io/cb"]) {
      const refused = await store("/create", {token: stranger.token, client: own({packageName: "com.mentra.notes", redirectUris: [redirectUri]})})
      expect([redirectUri, refused.status, refused.json.error]).toEqual([redirectUri, 422, "domain_mismatch"])
    }
    const mentra = await store("/create", {token: stranger.token, client: own({packageName: "com.mentra.notes", redirectUris: ["https://notes.mentraglass.com/auth/callback"]})})
    expect(mentra.status).toBe(201)
    expect(mentra.json.client.name).toBe("Notes")
  })

  test("the miniapp must be one Core knows, and not archived", async () => {
    const developer = await person()
    const unknown = await store("/create", {token: developer.token, client: own()})
    expect([unknown.status, unknown.json.error]).toEqual([422, "not_in_registry"])
    expect(unknown.json.error_description).toContain("Install it once in the Mentra App")

    await installed()
    await archive({kind: "package", value: NOTES}, {reason: "test", createdBy: "admin@mentra.glass"})
    const archived = await store("/create", {token: developer.token, client: own()})
    expect([archived.status, archived.json.error]).toEqual([422, "archived"])

    // Archived URL by URL, with nothing live left, is archived too; one live URL is enough.
    await installed("com.example.tools", {status: "archived"})
    expect((await store("/create", {token: developer.token, client: own({packageName: "com.example.tools", redirectUris: ["https://tools.example.com/cb"]})})).json.error).toBe("archived")
    await installed("com.example.tools")
    expect((await store("/create", {token: developer.token, client: own({packageName: "com.example.tools", redirectUris: ["https://tools.example.com/cb"]})})).status).toBe(201)
    expect(await WebsiteClientModel.countDocuments()).toBe(1)
  })

  test("a private miniapp Core could not read is named by its package", async () => {
    await installed(NOTES, {name: null, private: true, verification: "phone_reported", manifest: null})
    const developer = await person()
    const created = await store("/create", {token: developer.token, client: own()})
    expect(created.status).toBe(201)
    expect(created.json.client.name).toBe(NOTES)
  })

  test("a development client redirects to the developer's own computer, and signs in only them", async () => {
    await installed()
    const developer = await person()
    const created = await store("/create", {token: developer.token, client: own({type: "browser", environment: "development", redirectUris: ["http://127.0.0.1:5173/callback", "http://localhost:5173/callback"]})})
    expect(created.status).toBe(201)
    expect(created.json.secret).toBeNull()
    expect(created.json.client).toMatchObject({name: "Example Notes (development)", environment: "development"})
    expect(await findClient(created.json.client.clientId)).toMatchObject({website: {onlyUserId: developer.mentraUserId}})

    // It takes no address on the internet, even on the package's own domain, and a production one takes no loopback.
    for (const [environment, redirectUri] of [["development", "https://notes.example.com/cb"], ["production", "http://127.0.0.1:5173/callback"], ["development", "http://192.168.1.4:5173/cb"], ["development", "http://localhost/cb"]]) {
      const refused = await store("/create", {token: developer.token, client: own({type: "browser", environment, redirectUris: [redirectUri]})})
      expect([redirectUri, refused.status]).toEqual([redirectUri, 400])
    }
  })

  test("the Store's signature alone registers nothing: the person's token decides", async () => {
    await installed()
    const unverified = await person()
    await SigninIdentityModel.updateOne({mentraUserId: unverified.mentraUserId}, {$set: {emailVerified: false}})

    expect((await store("/create", {token: "not-a-token", client: own()})).status).toBe(401)
    expect((await store("/create", {client: own()})).status).toBe(400)
    const refused = await store("/create", {token: unverified.token, client: own()})
    expect([refused.status, refused.json.reason]).toEqual([403, "email_unverified"])
    // Nothing the Store adds to the body stands in for the person: no owner, name or access of its choosing.
    const developer = await person()
    const padded = await store("/create", {token: developer.token, client: {...own(), name: "Mentra", ownerUserId: "mu_victim", access: "private", accessWorkspaceIds: ["ws_x"]}})
    expect(padded.json.client).toMatchObject({name: "Example Notes", ownerUserId: developer.mentraUserId, access: "public", accessWorkspaceIds: []})
    expect(await WebsiteClientModel.countDocuments()).toBe(1)
  })

  test("only the Store, with a valid signature", async () => {
    await installed()
    const developer = await person()
    const body = {token: developer.token, client: own()}
    expect((await store("/create", body, {unsigned: true})).status).toBe(401)
    expect((await store("/create", body, {secret: "wrong"})).status).toBe(401)
    expect((await store("/create", body, {service: "fleet"})).status).toBe(403)
    expect(await WebsiteClientModel.countDocuments()).toBe(0)
  })

  test("a person sees and changes only the websites they registered, an admin's included", async () => {
    await installed()
    const alice = await person()
    const bob = await person()
    const orgAdmin = await person(ADMIN_EMAIL)
    const hers = (await store("/create", {token: alice.token, client: own()})).json.client
    // Two people who both control the domain may each register; neither manages the other's.
    const his = (await store("/create", {token: bob.token, client: own({redirectUris: ["https://staging.example.com/cb"]})})).json.client
    const admins = (await admin("POST", "", orgAdmin, site({packageName: NOTES}))).json.client

    expect((await store("/list", {token: bob.token})).json.clients.map((row: {clientId: string}) => row.clientId)).toEqual([his.clientId])
    for (const clientId of [hers.clientId, admins.clientId]) {
      for (const route of ["/update", "/regenerate-secret", "/delete"]) {
        const refused = await store(route, {token: bob.token, clientId, changes: {status: "disabled"}})
        expect([route, refused.status]).toEqual([route, 404])
      }
    }
    expect(await WebsiteClientModel.countDocuments({status: "active"})).toBe(3)
    // An Organization Admin sees them all, with whose each is, and can switch any off.
    const all = (await admin("GET", "", orgAdmin)).json.clients
    expect(all.map((row: {ownerUserId: string | null}) => row.ownerUserId).sort()).toEqual([alice.mentraUserId, bob.mentraUserId, null].sort())
    expect((await admin("PATCH", `/${his.clientId}`, orgAdmin, {status: "disabled"})).json.client.status).toBe("disabled")
  })

  test("one developer holds at most a fixed number of websites", async () => {
    await installed()
    const developer = await person()
    for (let index = 0; index < MAX_WEBSITES_PER_DEVELOPER; index++) {
      expect((await store("/create", {token: developer.token, client: own({type: "browser", redirectUris: [`https://notes.example.com/cb${index}`]})})).status).toBe(201)
    }
    const over = await store("/create", {token: developer.token, client: own()})
    expect([over.status, over.json.error]).toEqual([422, "too_many_websites"])
    // Someone else is not held to it.
    expect((await store("/create", {token: (await person()).token, client: own()})).status).toBe(201)
  })
})
