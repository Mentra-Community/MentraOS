/**
 * @fileoverview The admin portal's miniapp registry (`/api/admin/registry`): the entry list and its export, the
 * archive rules, and registering URLs as an Organization Admin.
 *
 * These drive the real Core app (`createApp`) at `/api/admin`, with the real principal middleware, services and
 * models against a local replica set. Two boundaries are faked: the identity provider (`support/fake-idp.ts`), which
 * signs the access tokens people present as bearers, and Core's fetcher (`fetchMiniappManifest`): each test says
 * what each URL serves. People reach the admin API with an admin portal session cookie or a bearer; operator keys
 * (`mak_`) and workspace keys (`msk_`) are real rows made through the public APIs; a phone token comes from Core's
 * own token exchange. Entries are seeded straight into the collection, as registrations leave them, except where
 * a test registers through the route.
 *
 * What it pins: only an Organization Admin (`organization.registry.administer`) reaches any route, and an operator
 * key never does, whatever its scopes; the list shows every entry unredacted, newest first, searchable and
 * filterable, 50 to a page; archiving by URL, package, domain and account archives what it covers, refuses phones'
 * installs and updates, and refuses URLs registered later; the coverage answer counts what a rule covers before it
 * is made; unarchiving restores only what no other rule covers; an Organization Admin's registration is verified
 * as a phone's, as that person; the CSV export holds every entry; every write and the export are in the admin
 * audit log.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The database is
 * dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/admin-registry.integration.test.ts`
 */

import crypto from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import {
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
} from "../packages/core/src/models/miniapp-registry.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {RevokedJtiModel} from "../packages/core/src/models/revoked-jti.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAssignedPackagesModel} from "../packages/core/src/models/workspace-assigned-packages.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import * as fetcher from "../packages/core/src/services/registry/miniapp-fetcher"
import type {MiniappFetchResult} from "../packages/core/src/services/registry/miniapp-fetcher"
import {
  answerWithoutReading,
  registerMiniappUrl,
  registryStatus,
  reverificationsIdle,
} from "../packages/core/src/services/registry/registry.service"
import * as session from "../packages/core/src/services/session.service"
import {createSession} from "../packages/core/src/services/session.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {
  ADMIN_REGISTRY_REGISTER_MAX_URLS,
  OPERATOR_KEY_SCOPES,
  type AdminRegistryEntriesResponse,
  type AdminRegistryEntryView,
} from "../packages/workspace-contract/src/index"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  coreAccessToken,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  AccountCodeModel,
  AccountEmailModel,
  AdminActionAuditLogModel,
  BrowserSessionModel,
  LicenseModel,
  LicenseSeatModel,
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
  RefreshTokenModel,
  RevokedJtiModel,
  SigninIdentityModel,
  UserModel,
  WorkspaceAssignedPackagesModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as const

const REGISTRY = "/api/admin/registry"
const SHA = "AB".repeat(32)

/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_BILLING_URL: undefined,
  CLOUD_CORE_BILLING_SECRET: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENABLED_FEATURES: undefined,
  CLOUD_CORE_ENVIRONMENT: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: "https://core.example.test/invite/{token}",
  RESEND_API_KEY: undefined,
  REFRESH_TOKEN_PEPPER: "admin-registry-test-pepper",
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}
const mocks: Array<{mockRestore(): void}> = []

/** What each URL serves to Core's fetcher, by request: the bearer is the challenge retry's token. */
type Serve = (request: {claims: jose.JWTPayload | null}) => MiniappFetchResult
let served: Map<string, Serve>
/** Every fetch Core made, in order. */
let fetches: Array<{url: string; claims: jose.JWTPayload | null}>

// --- People and keys -------------------------------------------------------

interface Person {
  sub: string
  email: string
  mentraUserId: string
  /** A Core access token, for `Authorization: Bearer`. */
  bearer: string
  /** The person's admin portal session, as a `Cookie` header value. */
  cookie: string
}

/** A person with a Mentra account at the fake identity provider, a Core user and an admin portal session. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  idp.registerUser({sub, email, emailConfirmed: emailVerified})
  const bearer = await coreAccessToken({sub, email, emailVerified})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  const {cookieValue} = await createPortalSession("admin", {
    mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: sub,
    email,
    emailVerified,
    authTime: new Date(),
  })
  return {sub, email, mentraUserId, bearer, cookie: `${ADMIN_COOKIE}=${cookieValue}`}
}

const organizationAdmin = () => person("org-admin", {email: ADMIN_EMAIL})

/** A phone's Core access token, from Core's own token exchange of a Supabase session. */
async function phoneToken(key: string): Promise<string> {
  const sub = `supa-phone-${key}`
  idp.registerUser({sub, email: `${key}@phone.example.test`, emailConfirmed: true})
  const subjectToken = await idp.mint({sub, aud: "authenticated", role: "authenticated"})
  const {access_token: token} = await createSession({subjectToken})
  return token
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

/** One request through the real app, as a person (session cookie, or bearer when `via` says so) or a raw bearer token. */
async function call(
  method: string,
  path: string,
  opts: {as?: Person | string; via?: "session" | "bearer"; body?: unknown; origin?: string} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  const as = opts.as
  if (typeof as === "string") headers.authorization = `Bearer ${as}`
  else if (as && opts.via === "bearer") headers.authorization = `Bearer ${as.bearer}`
  else if (as) {
    headers.cookie = as.cookie
    if (method !== "GET" && method !== "HEAD") headers.origin = opts.origin ?? ADMIN_ORIGIN
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
    headers["content-type"] = "application/json"
  }
  const response = await app.request(`${ADMIN_ORIGIN}${path}`, {method, headers, body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A CSV or other non-JSON body is read from `text`.
  }
  return {status: response.status, headers: response.headers, json, text}
}

/** An operator key (`mak_`) created through the admin portal by an Organization Admin. */
async function operatorKey(name: string, scopes: readonly string[]): Promise<string> {
  const admin = await person(`creator-${name}`, {email: ADMIN_EMAIL})
  const created = await call("POST", "/api/admin/organization/credentials", {as: admin, body: {name, scopes}})
  expect(created.status).toBe(201)
  return created.json.token
}

/** A workspace with an owner, a workspace key the owner created, and an Admin who is not an Organization Admin. */
async function workspaceWithPeople() {
  const owner = await person("ws-owner")
  const workspace = await call("POST", "/api/workspaces", {as: owner, via: "bearer", body: {name: "Acme Robotics"}})
  expect(workspace.status).toBe(201)
  const workspaceId: string = workspace.json.workspaceId
  const credential = await call("POST", `/api/workspaces/${workspaceId}/credentials`, {
    as: owner,
    via: "bearer",
    body: {name: "ci", packageNames: ["com.acme.app"]},
  })
  expect(credential.status).toBe(201)
  const admin = await person("ws-admin")
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId: "wm_admin_1",
      workspaceId,
      mentraUserId: admin.mentraUserId,
      email: admin.email,
      role: "admin",
      status: "active",
      startedAt: new Date(),
    }),
  )
  return {owner, admin, workspaceId, workspaceKey: credential.json.token as string}
}

// --- Entries ---------------------------------------------------------------

let sequence = 0

type EntryDoc = {
  url: string
  packageName: string
  registrableDomain: string
  name: string | null
  version: string | null
  ageRating: string | null
  iconUrl: string | null
  verification: "verified" | "phone_reported"
  manifest: string | null
  private: boolean
  status: "active" | "archived"
  firstRegisteredAt: Date
  firstRegisteredBy: string
  lastVerifiedAt: Date | null
  lastVerifyAttemptAt: Date | null
  lastSeenVersion: string | null
}

/** A verified entry on `host` (a subdomain of example.com by default), as a registration leaves it. Seeded in order: later is newer. */
async function seedEntry(overrides: Partial<EntryDoc> & {host?: string} = {}): Promise<EntryDoc> {
  const n = ++sequence
  const {host: hostOverride, ...rest} = overrides
  const host = hostOverride ?? `app${n}.example.com`
  const label = host.split(".")[0]!.replace(/-/g, "_")
  const domain = host.split(".").slice(-2).join(".")
  const prefix = domain.split(".").reverse().join(".")
  const at = new Date(Date.UTC(2026, 9, 1) + n * 60_000)
  const doc: EntryDoc = {
    url: `https://${host}/`,
    packageName: `${prefix}.${label}`,
    registrableDomain: domain,
    name: `App ${n}`,
    version: "1.0.0",
    ageRating: "4+",
    iconUrl: `https://${host}/icon.png`,
    verification: "verified",
    manifest: "{}",
    private: false,
    status: "active",
    firstRegisteredAt: at,
    firstRegisteredBy: "mu_alice",
    lastVerifiedAt: at,
    lastVerifyAttemptAt: at,
    lastSeenVersion: "1.0.0",
    ...rest,
  }
  await MiniappRegistryEntryModel.create(doc)
  return doc
}

const entryRow = (url: string) => MiniappRegistryEntryModel.findOne({url}).lean()
const urlsOf = (reply: Reply) => (reply.json as AdminRegistryEntriesResponse).items.map((item) => item.url)

// --- Serving ---------------------------------------------------------------

/** A served `miniapp.json`. */
function manifest(packageName: string, overrides: Record<string, unknown> = {}) {
  return {
    packageName,
    version: "1.0.0",
    name: "Notes",
    description: "Take notes with your voice.",
    icon: "icon.png",
    ageRating: "4+",
    entry: {background: "background/index.js", ui: "ui/index.html"},
    bundle: {url: `${packageName}-1.0.0.zip`, sha256: SHA},
    ...overrides,
  }
}

function ok(body: unknown, finalUrl: string): MiniappFetchResult {
  return {kind: "ok", manifest: {finalUrl, status: 200, body: JSON.stringify(body), etag: "\"v1\""}}
}

/** `url` serves `body` at `<url>/miniapp.json` to anyone. */
function serve(url: string, body: unknown): void {
  served.set(url, () => ok(body, `${url}miniapp.json`))
}

/** A phone's registration, through the service, as the person `mentraUserId`. */
const phoneRegisters = (url: string, mentraUserId = "mu_phone") =>
  registerMiniappUrl({url, registrant: {mentraUserId, tenantId: "mentra"}})

const phoneStatus = async (url: string) =>
  (
    await registryStatus({
      entries: [{url, version: "9.9.9"}],
      caller: {mentraUserId: "mu_phone", tenantId: "mentra"},
      reverify: false,
    })
  ).statuses[0]!.status

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("admin-registry")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would silently win.
  // Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
  verified = true
  // Startup migrations do not run here; the transactions need their collections and indexes.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && MiniappRegistryEntryModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
    await MiniappRegistryEntryModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  const strip = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")
  restoreEnv = applyEnv({
    ...TEST_ENV,
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  })
  // Core's signing keys are read from the environment on first use; other suites in this process set their own.
  resetCoreKeyCaches()
  session.resetSigningKeyCache()
  assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
  resetIdpTokenCaches()
  sequence = 0
  served = new Map()
  fetches = []
  mocks.push(
    spyOn(fetcher, "fetchMiniappManifest").mockImplementation(async (url, options) => {
      const claims = options?.bearer ? jose.decodeJwt(options.bearer) : null
      fetches.push({url, claims})
      const respond = served.get(url)
      return respond ? respond({claims}) : {kind: "unreachable", reason: "dns"}
    }),
  )
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
  app = createApp({readinessChecks: []})
})

afterEach(async () => {
  await reverificationsIdle()
  for (const mock of mocks.splice(0)) mock.mockRestore()
  idp.restore()
  restoreEnv()
  resetCoreKeyCaches()
  session.resetSigningKeyCache()
})

// --- Who -------------------------------------------------------------------

describe("who may administer the registry", () => {
  const READS = [
    `${REGISTRY}/entries`,
    `${REGISTRY}/entries?q=example`,
    `${REGISTRY}/rules`,
    `${REGISTRY}/export`,
    `${REGISTRY}/coverage?kind=domain&value=example.com`,
  ]

  test("an Organization Admin reaches every route, by session and by bearer", async () => {
    await seedEntry()
    const admin = await organizationAdmin()
    for (const via of ["session", "bearer"] as const) {
      for (const path of READS) {
        const reply = await call("GET", path, {as: admin, via})
        expect([via, path, reply.status]).toEqual([via, path, 200])
      }
    }
    const me = await call("GET", "/api/admin/me", {as: admin})
    expect(me.json.organization.capabilities).toContain("organization.registry.administer")
  })

  test("a workspace owner or admin, an operator key, a workspace key and a phone token are refused, and change nothing", async () => {
    const entry = await seedEntry({name: "Secret Inventory"})
    const ws = await workspaceWithPeople()
    // Every scope an operator key can carry.
    const operator = await operatorKey("all-scopes", [...OPERATOR_KEY_SCOPES])
    const phone = await phoneToken("holder")
    const writes: Array<[path: string, body: unknown]> = [
      [`${REGISTRY}/archive`, {rule: {kind: "url", value: entry.url}, reason: "spam"}],
      [`${REGISTRY}/unarchive`, {rule: {kind: "url", value: entry.url}}],
      [`${REGISTRY}/register`, {urls: ["https://notes.example.org/"]}],
    ]

    const refused: Array<[label: string, caller: Person | string, via: "session" | "bearer" | undefined, status: number]> = [
      ["workspace owner (session)", ws.owner, "session", 403],
      ["workspace owner (bearer)", ws.owner, "bearer", 403],
      ["workspace admin (session)", ws.admin, "session", 403],
      ["workspace admin (bearer)", ws.admin, "bearer", 403],
      ["operator key with every scope", operator, undefined, 403],
      ["workspace key", ws.workspaceKey, undefined, 403],
      // A phone's access token is no credential on the admin surface at all.
      ["phone token", phone, undefined, 401],
    ]
    for (const [label, caller, via, status] of refused) {
      for (const path of READS) {
        const reply = await call("GET", path, {as: caller, via})
        expect([label, path, reply.status]).toEqual([label, path, status])
        expect([label, path, reply.text.includes("Secret Inventory")]).toEqual([label, path, false])
      }
      for (const [path, body] of writes) {
        const reply = await call("POST", path, {as: caller, via, body})
        expect([label, path, reply.status]).toEqual([label, path, status])
      }
    }
    expect((await call("GET", `${REGISTRY}/entries`)).status).toBe(401)
    expect((await call("GET", `${REGISTRY}/entries`, {as: "mak_local_notakey"})).status).toBe(401)

    // Nothing was archived, registered or fetched.
    expect(await MiniappRegistryArchiveRuleModel.countDocuments({})).toBe(0)
    expect(await MiniappRegistryEntryModel.countDocuments({})).toBe(1)
    expect(fetches).toEqual([])
    expect(await AdminActionAuditLogModel.countDocuments({action: /^miniapp_registry\./})).toBe(0)
  })

  test("no operator key holds the capability: it is not a scope a key can be created with", async () => {
    const operator = await operatorKey("all-scopes", [...OPERATOR_KEY_SCOPES])
    const me = await call("GET", "/api/admin/me", {as: operator})
    expect(me.json.organization.capabilities).not.toContain("organization.registry.administer")

    const admin = await organizationAdmin()
    const forged = await call("POST", "/api/admin/organization/credentials", {
      as: admin,
      body: {name: "registry", scopes: ["organization.registry.administer"]},
    })
    expect(forged.status).toBe(400)
  })

  test("an allowlisted address the identity provider has not verified is refused", async () => {
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})
    for (const via of ["session", "bearer"] as const) {
      expect([via, (await call("GET", `${REGISTRY}/entries`, {as: claimed, via})).status]).toEqual([via, 403])
    }
  })

  test("a session write from another origin is refused and archives nothing", async () => {
    const entry = await seedEntry()
    const admin = await organizationAdmin()
    const reply = await call("POST", `${REGISTRY}/archive`, {
      as: admin,
      origin: "https://evil.example",
      body: {rule: {kind: "url", value: entry.url}},
    })
    expect(reply.status).toBe(403)
    expect(await MiniappRegistryArchiveRuleModel.countDocuments({})).toBe(0)
    expect((await entryRow(entry.url))!.status).toBe("active")
  })
})

// --- The list --------------------------------------------------------------

describe("GET /api/admin/registry/entries", () => {
  test("lists every entry, most recently registered first, with nothing redacted", async () => {
    const verifiedEntry = await seedEntry({host: "notes.example.com", name: "Notes", version: "2.0.0", ageRating: "13+"})
    const reported = await seedEntry({
      host: "inventory.globex.com",
      name: "Inventory",
      iconUrl: null,
      manifest: null,
      verification: "phone_reported",
      lastVerifiedAt: null,
      firstRegisteredBy: "mu_bob",
    })
    // A private server that refused Core's token: only the package name is known.
    const privateEntry = await seedEntry({
      host: "tools.acme.com",
      name: null,
      version: null,
      ageRating: null,
      iconUrl: null,
      manifest: null,
      verification: "phone_reported",
      private: true,
      lastVerifiedAt: null,
    })
    const admin = await organizationAdmin()

    const reply = await call("GET", `${REGISTRY}/entries`, {as: admin})

    expect(reply.status).toBe(200)
    expect(reply.headers.get("cache-control")).toBe("no-store")
    expect(reply.json.next).toBeNull()
    expect(urlsOf(reply)).toEqual([privateEntry.url, reported.url, verifiedEntry.url])
    const byUrl = new Map<string, AdminRegistryEntryView>(reply.json.items.map((item: AdminRegistryEntryView) => [item.url, item]))
    expect(byUrl.get(verifiedEntry.url)).toEqual({
      url: "https://notes.example.com/",
      packageName: "com.example.notes",
      registrableDomain: "example.com",
      name: "Notes",
      version: "2.0.0",
      ageRating: "13+",
      iconUrl: "https://notes.example.com/icon.png",
      verification: "verified",
      private: false,
      status: "active",
      archivedBy: [],
      firstRegisteredAt: verifiedEntry.firstRegisteredAt.toISOString(),
      firstRegisteredBy: "mu_alice",
      lastVerifiedAt: verifiedEntry.lastVerifiedAt!.toISOString(),
    })
    expect(byUrl.get(reported.url)).toMatchObject({
      name: "Inventory",
      verification: "phone_reported",
      lastVerifiedAt: null,
      firstRegisteredBy: "mu_bob",
    })
    expect(byUrl.get(privateEntry.url)).toMatchObject({name: null, private: true, packageName: "com.acme.tools"})
    // Core's verified copy of the manifest stays in Core.
    expect(reply.text).not.toContain("manifest")
  })

  test("search matches the URL, package, name or domain as plain text, ignoring case, and an account by its id", async () => {
    const notes = await seedEntry({host: "notes.example.com", name: "Voice Notes"})
    const acme = await seedEntry({host: "tools.acme.com", name: "Acme Tools", firstRegisteredBy: "mu_spammer"})
    const dotted = await seedEntry({host: "a-b.globex.com", name: "Globex (beta)"})
    const admin = await organizationAdmin()
    const search = async (q: string) => urlsOf(await call("GET", `${REGISTRY}/entries?q=${encodeURIComponent(q)}`, {as: admin}))

    expect(await search("NOTES.example")).toEqual([notes.url])
    expect(await search("com.acme")).toEqual([acme.url])
    expect(await search("voice")).toEqual([notes.url])
    expect(await search("globex.com")).toEqual([dotted.url])
    expect(await search("  acme tools  ")).toEqual([acme.url])
    expect(await search("mu_spammer")).toEqual([acme.url])
    // Plain text, never a pattern.
    expect(await search("(beta)")).toEqual([dotted.url])
    expect(await search(".*")).toEqual([])
    expect(await search("mu_spam")).toEqual([])
    expect(await search("")).toEqual([dotted.url, acme.url, notes.url])
  })

  test("filters by status and by verification", async () => {
    const active = await seedEntry()
    const archived = await seedEntry({status: "archived"})
    const reported = await seedEntry({verification: "phone_reported", manifest: null, lastVerifiedAt: null})
    const admin = await organizationAdmin()
    const list = async (query: string) => urlsOf(await call("GET", `${REGISTRY}/entries?${query}`, {as: admin}))

    expect(await list("status=archived")).toEqual([archived.url])
    expect(await list("status=active")).toEqual([reported.url, active.url])
    expect(await list("verification=phone_reported")).toEqual([reported.url])
    expect(await list("verification=verified&status=active")).toEqual([active.url])
    for (const bad of ["status=deleted", "verification=maybe", `q=${"x".repeat(201)}`, "cursor=nope"]) {
      const reply = await call("GET", `${REGISTRY}/entries?${bad}`, {as: admin})
      expect([bad, reply.status, reply.json?.error]).toEqual([bad, 400, "invalid_request"])
    }
  })

  test("pages 50 at a time with the cursor, and an entry registered meanwhile doesn't shift the next page", async () => {
    const seeded: EntryDoc[] = []
    for (let index = 0; index < 55; index++) seeded.push(await seedEntry())
    const newestFirst = seeded.map((entry) => entry.url).reverse()
    const admin = await organizationAdmin()

    const first = await call("GET", `${REGISTRY}/entries`, {as: admin})
    expect(urlsOf(first)).toEqual(newestFirst.slice(0, 50))
    expect(typeof first.json.next).toBe("string")
    await seedEntry()
    const second = await call("GET", `${REGISTRY}/entries?cursor=${first.json.next}`, {as: admin})
    expect(urlsOf(second)).toEqual(newestFirst.slice(50))
    expect(second.json.next).toBeNull()
  })
})

// --- Archiving -------------------------------------------------------------

describe("archiving by URL, package, domain and account", () => {
  test("each rule kind archives what it covers, refuses installs and updates, and leaves the rest", async () => {
    const admin = await organizationAdmin()
    const kinds = [
      {kind: "url", setup: async () => (await seedEntry({host: "one.alpha.com"})).url, value: (url: string) => url},
      {kind: "package", setup: async () => (await seedEntry({host: "two.beta.com"})).url, value: () => "com.beta.two"},
      {kind: "domain", setup: async () => (await seedEntry({host: "three.gamma.com"})).url, value: () => "gamma.com"},
      {
        kind: "account",
        setup: async () => (await seedEntry({host: "four.delta.com", firstRegisteredBy: "mu_spammer"})).url,
        value: () => "mu_spammer",
      },
    ] as const
    const bystander = await seedEntry({host: "safe.epsilon.com"})

    for (const {kind, setup, value} of kinds) {
      const url = await setup()
      const rule = {kind, value: value(url)}
      expect([kind, await phoneStatus(url)]).toEqual([kind, "active"])

      const coverage = await call("GET", `${REGISTRY}/coverage?kind=${kind}&value=${encodeURIComponent(rule.value)}`, {as: admin})
      expect([kind, coverage.status, coverage.json]).toEqual([kind, 200, {rule, entries: 1, activeEntries: 1, exists: false}])

      const archived = await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule, reason: `junk ${kind}`}})
      expect([kind, archived.status, archived.json]).toEqual([kind, 200, {rule, created: true, entriesArchived: 1}])

      // The phone is refused the install and stops updating it.
      expect([kind, await phoneStatus(url)]).toEqual([kind, "archived"])
      const answer = await answerWithoutReading({
        url,
        registrant: {mentraUserId: kind === "account" ? "mu_spammer" : "mu_phone", tenantId: "mentra"},
      })
      expect([kind, answer]).toEqual([kind, {result: "archived"}])

      const listed = await call("GET", `${REGISTRY}/entries?q=${encodeURIComponent(url)}`, {as: admin})
      expect([kind, listed.json.items[0].status, listed.json.items[0].archivedBy]).toEqual([kind, "archived", [kind]])
      const after = await call("GET", `${REGISTRY}/coverage?kind=${kind}&value=${encodeURIComponent(rule.value)}`, {as: admin})
      expect([kind, after.json]).toEqual([kind, {rule, entries: 1, activeEntries: 0, exists: true}])
    }

    expect((await entryRow(bystander.url))!.status).toBe("active")
    expect(await phoneStatus(bystander.url)).toBe("active")

    const rules = await call("GET", `${REGISTRY}/rules`, {as: admin})
    expect(rules.status).toBe(200)
    expect(rules.json.next).toBeNull()
    // Newest first, each with its reason and the Organization Admin who made it.
    expect(rules.json.items.map((item: any) => [item.kind, item.reason, item.createdBy])).toEqual([
      ["account", "junk account", ADMIN_EMAIL],
      ["domain", "junk domain", ADMIN_EMAIL],
      ["package", "junk package", ADMIN_EMAIL],
      ["url", "junk url", ADMIN_EMAIL],
    ])
    for (const item of rules.json.items) expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false)
  })

  test("a package, domain or account rule also refuses URLs registered after it, and creates no entry", async () => {
    const admin = await organizationAdmin()
    for (const rule of [
      {kind: "package", value: "com.beta.later"},
      {kind: "domain", value: "gamma.com"},
      {kind: "account", value: "mu_spammer"},
    ]) {
      const reply = await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule}})
      // Nothing to archive yet: the rule stands for what comes.
      expect([rule.kind, reply.status, reply.json.entriesArchived]).toEqual([rule.kind, 200, 0])
    }
    serve("https://later.beta.com/", manifest("com.beta.later"))
    serve("https://new.gamma.com/", manifest("com.gamma.new"))
    serve("https://fresh.delta.com/", manifest("com.delta.fresh"))

    expect(await phoneRegisters("https://later.beta.com/")).toEqual({result: "archived"})
    expect(await phoneRegisters("https://new.gamma.com/")).toEqual({result: "archived"})
    expect(await phoneRegisters("https://fresh.delta.com/", "mu_spammer")).toEqual({result: "archived"})
    expect(await MiniappRegistryEntryModel.countDocuments({})).toBe(0)
    // Someone else registering on another domain is unaffected.
    expect((await phoneRegisters("https://fresh.delta.com/", "mu_phone")).result).toBe("accepted")
  })

  test("archiving a rule that exists again keeps its first reason and author", async () => {
    const entry = await seedEntry({host: "notes.example.com"})
    const admin = await organizationAdmin()
    const rule = {kind: "domain", value: "example.com"}
    expect((await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule, reason: "first"}})).json).toEqual({
      rule,
      created: true,
      entriesArchived: 1,
    })
    expect((await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule, reason: "second"}})).json).toEqual({
      rule,
      created: false,
      entriesArchived: 0,
    })
    const rules = await call("GET", `${REGISTRY}/rules`, {as: admin})
    expect(rules.json.items.map((item: any) => item.reason)).toEqual(["first"])
    expect((await entryRow(entry.url))!.status).toBe("archived")
  })

  test("a rule's value is answered in Core's form", async () => {
    await seedEntry({host: "notes.example.com"})
    const admin = await organizationAdmin()
    const coverage = await call("GET", `${REGISTRY}/coverage?kind=url&value=${encodeURIComponent(" https://Notes.Example.com ")}`, {
      as: admin,
    })
    expect(coverage.json).toEqual({rule: {kind: "url", value: "https://notes.example.com/"}, entries: 1, activeEntries: 1, exists: false})
    const archived = await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule: {kind: "domain", value: "EXAMPLE.com."}}})
    expect(archived.json.rule).toEqual({kind: "domain", value: "example.com"})
  })

  test("a rule that can't name an entry, or a reason that is too long, is refused and nothing is archived", async () => {
    await seedEntry({host: "notes.example.com"})
    const admin = await organizationAdmin()
    const bad: unknown[] = [
      {rule: {kind: "url", value: "http://notes.example.com/"}},
      {rule: {kind: "url", value: "https://192.168.1.10/"}},
      {rule: {kind: "package", value: "not a package"}},
      // A subdomain isn't a registrable domain: archive the URL, or the whole domain.
      {rule: {kind: "domain", value: "notes.example.com"}},
      {rule: {kind: "domain", value: "com"}},
      {rule: {kind: "account", value: "mu bad"}},
      {rule: {kind: "workspace", value: "ws_1"}},
      {rule: {kind: "url"}},
      {rule: "example.com"},
      {rule: {kind: "domain", value: "example.com"}, reason: "x".repeat(501)},
      {rule: {kind: "domain", value: "example.com"}, reason: 7},
    ]
    for (const body of bad) {
      const reply = await call("POST", `${REGISTRY}/archive`, {as: admin, body})
      expect([body, reply.status, reply.json?.error]).toEqual([body, 400, "invalid_request"])
    }
    const malformed = await call("POST", `${REGISTRY}/archive`, {as: admin, body: "{not json"})
    expect(malformed.status).toBe(400)
    const coverage = await call("GET", `${REGISTRY}/coverage?kind=domain&value=notes.example.com`, {as: admin})
    expect(coverage.status).toBe(400)
    expect(await MiniappRegistryArchiveRuleModel.countDocuments({})).toBe(0)
  })

  test("unarchiving removes the rule and restores only the entries no other rule covers", async () => {
    const alone = await seedEntry({host: "alone.example.com"})
    const both = await seedEntry({host: "both.example.com"})
    const admin = await organizationAdmin()
    const domain = {kind: "domain", value: "example.com"}
    const pkg = {kind: "package", value: "com.example.both"}
    await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule: domain}})
    await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule: pkg}})

    const coverage = await call("GET", `${REGISTRY}/coverage?kind=domain&value=example.com`, {as: admin})
    expect(coverage.json).toEqual({rule: domain, entries: 2, activeEntries: 0, exists: true})
    const listed = await call("GET", `${REGISTRY}/entries?q=both.example.com`, {as: admin})
    expect(listed.json.items[0].archivedBy).toEqual(["package", "domain"])

    const reply = await call("POST", `${REGISTRY}/unarchive`, {as: admin, body: {rule: domain}})
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({rule: domain, removed: true, entriesRestored: 1})
    expect(await phoneStatus(alone.url)).toBe("active")
    expect(await phoneStatus(both.url)).toBe("archived")
    const rules = await call("GET", `${REGISTRY}/rules`, {as: admin})
    expect(rules.json.items.map((item: any) => item.kind)).toEqual(["package"])

    // A rule that isn't there is no error.
    expect((await call("POST", `${REGISTRY}/unarchive`, {as: admin, body: {rule: domain}})).json).toEqual({
      rule: domain,
      removed: false,
      entriesRestored: 0,
    })
    expect((await call("POST", `${REGISTRY}/unarchive`, {as: admin, body: {rule: {kind: "domain", value: "com"}}})).status).toBe(400)
  })

  test("every archive and unarchive is in the admin audit log, with the Organization Admin who did it", async () => {
    await seedEntry({host: "notes.example.com"})
    const admin = await organizationAdmin()
    const rule = {kind: "domain", value: "example.com"}
    await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule, reason: "phishing"}})
    await call("POST", `${REGISTRY}/unarchive`, {as: admin, body: {rule}, via: "bearer"})

    // The admin portal's audit log shows them (sorted here by action: both may land in the same millisecond).
    const audit = await call("GET", "/api/admin/audit-log", {as: admin})
    const events = audit.json.events
      .filter((event: any) => event.action.startsWith("miniapp_registry."))
      .sort((a: any, b: any) => a.action.localeCompare(b.action))
    expect(events.map((event: any) => [event.action, event.adminId, event.targetType, event.targetId, event.reason, event.metadata])).toEqual([
      ["miniapp_registry.archive", ADMIN_EMAIL, "miniapp_registry_rule", "domain:example.com", "phishing", {created: true, entriesArchived: 1}],
      ["miniapp_registry.unarchive", ADMIN_EMAIL, "miniapp_registry_rule", "domain:example.com", null, {removed: true, entriesRestored: 1}],
    ])
  })
})

// --- Registering -------------------------------------------------------------

describe("POST /api/admin/registry/register", () => {
  test("verifies each URL as a phone's registration would, with the Organization Admin as the person registering", async () => {
    const admin = await organizationAdmin()
    serve("https://notes.example.com/", manifest("com.example.notes", {name: "Notes"}))

    const reply = await call("POST", `${REGISTRY}/register`, {as: admin, body: {urls: ["  https://Notes.example.com  "]}})

    expect(reply.status).toBe(200)
    expect(reply.headers.get("cache-control")).toBe("no-store")
    expect(reply.json).toEqual({
      results: [
        {
          input: "  https://Notes.example.com  ",
          result: "accepted",
          url: "https://notes.example.com/",
          packageName: "com.example.notes",
          name: "Notes",
        },
      ],
    })
    const row = await entryRow("https://notes.example.com/")
    expect(row).toMatchObject({verification: "verified", firstRegisteredBy: admin.mentraUserId, name: "Notes", status: "active"})
    expect(fetches.map((fetch) => fetch.url)).toEqual(["https://notes.example.com/"])
  })

  test("answers each URL of a batch in order, once each", async () => {
    const admin = await organizationAdmin()
    serve("https://notes.example.com/", manifest("com.example.notes"))
    serve("https://broken.example.com/", {packageName: "com.example.broken"})
    serve("https://wrong.example.com/", manifest("com.other.wrong"))
    serve("https://blocked.spam.com/", manifest("com.spam.blocked"))
    await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule: {kind: "domain", value: "spam.com"}}})

    const urls = [
      "https://notes.example.com/",
      "https://broken.example.com/",
      "https://wrong.example.com/",
      "https://offline.example.com/",
      "https://blocked.spam.com/",
      "http://plain.example.com/",
      "http://192.168.1.4/",
      "ftp://files.example.com/",
      "https://notes.example.com/",
    ]
    const reply = await call("POST", `${REGISTRY}/register`, {as: admin, body: {urls}})

    expect(reply.status).toBe(200)
    expect(reply.json.results.map((result: any) => [result.input, result.result, result.reason ?? null])).toEqual([
      ["https://notes.example.com/", "accepted", null],
      ["https://broken.example.com/", "not_a_miniapp", "invalid_manifest"],
      ["https://wrong.example.com/", "not_a_miniapp", "domain_mismatch"],
      // Core couldn't read it and holds no report: nothing is recorded.
      ["https://offline.example.com/", "unreachable", null],
      ["https://blocked.spam.com/", "archived", null],
      ["http://plain.example.com/", "not_a_miniapp", "not_https"],
      ["http://192.168.1.4/", "not_a_miniapp", "local_network_url"],
      ["ftp://files.example.com/", "invalid_url", null],
    ])
    expect((await MiniappRegistryEntryModel.find({}).lean()).map((row) => row.url)).toEqual(["https://notes.example.com/"])
  })

  test("a private server gets a miniapp token for the Organization Admin, and nothing else", async () => {
    const admin = await organizationAdmin()
    served.set("https://tools.acme.com/", ({claims}) => {
      if (!claims) return {kind: "challenge", packageName: "com.acme.tools"}
      return claims.sub === admin.mentraUserId ? ok(manifest("com.acme.tools", {name: "Acme Tools"}), "https://tools.acme.com/miniapp.json") : {kind: "refused", status: 403}
    })

    const reply = await call("POST", `${REGISTRY}/register`, {as: admin, body: {urls: ["https://tools.acme.com/"]}})

    expect(reply.json.results).toEqual([
      {input: "https://tools.acme.com/", result: "accepted", url: "https://tools.acme.com/", packageName: "com.acme.tools", name: "Acme Tools"},
    ])
    expect(fetches.map((fetch) => [fetch.url, fetch.claims?.aud ?? null])).toEqual([
      ["https://tools.acme.com/", null],
      ["https://tools.acme.com/", "com.acme.tools"],
    ])
    expect((await entryRow("https://tools.acme.com/"))!.private).toBe(true)
  })

  test("takes 1 to 50 URLs, each a string", async () => {
    const admin = await organizationAdmin()
    const tooMany = Array.from({length: ADMIN_REGISTRY_REGISTER_MAX_URLS + 1}, (_, index) => `https://app${index}.example.com/`)
    for (const body of [{urls: []}, {urls: tooMany}, {urls: [7]}, {urls: "https://notes.example.com/"}, {}, {urls: ["x".repeat(2049)]}]) {
      const reply = await call("POST", `${REGISTRY}/register`, {as: admin, body})
      expect([reply.status, reply.json?.error]).toEqual([400, "invalid_request"])
    }
    expect(fetches).toEqual([])
    // Fifty is fine, and blank lines don't count.
    const fifty = tooMany.slice(0, ADMIN_REGISTRY_REGISTER_MAX_URLS)
    const reply = await call("POST", `${REGISTRY}/register`, {as: admin, body: {urls: [...fifty, "", "   "]}})
    expect(reply.status).toBe(200)
    expect(reply.json.results).toHaveLength(ADMIN_REGISTRY_REGISTER_MAX_URLS)
    expect(new Set(fetches.map((fetch) => fetch.url)).size).toBe(ADMIN_REGISTRY_REGISTER_MAX_URLS)
  })

  test("each URL registered is in the admin audit log with what it came to", async () => {
    const admin = await organizationAdmin()
    serve("https://notes.example.com/", manifest("com.example.notes"))
    await call("POST", `${REGISTRY}/register`, {as: admin, body: {urls: ["https://notes.example.com/", "https://offline.example.com/"]}})

    const rows = await AdminActionAuditLogModel.find({action: "miniapp_registry.register"}).sort({targetId: 1}).lean()
    expect(rows.map((row) => [row.adminId, row.targetType, row.targetId, row.metadata])).toEqual([
      [ADMIN_EMAIL, "miniapp_url", "https://notes.example.com/", {result: "accepted"}],
      [ADMIN_EMAIL, "miniapp_url", "https://offline.example.com/", {result: "unreachable"}],
    ])
  })
})

// --- The export ------------------------------------------------------------

describe("GET /api/admin/registry/export", () => {
  test("is a CSV of every entry, more than a page of them, with its status from the rules", async () => {
    const admin = await organizationAdmin()
    for (let index = 0; index < 60; index++) await seedEntry()
    const tricky = await seedEntry({host: "tricky.example.org", name: "=HYPERLINK(\"https://evil.example\"), \"quoted\"", ageRating: null})
    const reported = await seedEntry({host: "inventory.globex.com", verification: "phone_reported", manifest: null, lastVerifiedAt: null, private: true})
    await call("POST", `${REGISTRY}/archive`, {as: admin, body: {rule: {kind: "domain", value: "globex.com"}}})
    // A rule made after the entry, without its status set: the rule still decides.
    await MiniappRegistryEntryModel.updateOne({url: reported.url}, {$set: {status: "active"}})

    const reply = await call("GET", `${REGISTRY}/export`, {as: admin})

    expect(reply.status).toBe(200)
    expect(reply.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(reply.headers.get("content-disposition")).toBe('attachment; filename="miniapp-registry.csv"')
    expect(reply.headers.get("cache-control")).toBe("no-store")
    const lines = reply.text.trimEnd().split("\r\n")
    expect(lines[0]).toBe(
      "url,package_name,name,version,age_rating,verification,private,status,first_registered_at,last_verified_at",
    )
    expect(lines).toHaveLength(1 + 62)
    // Oldest first, as registered.
    expect(lines[1]!.startsWith("https://app1.example.com/,com.example.app1,App 1,1.0.0,4+,verified,false,active,")).toBe(true)
    // A cell a spreadsheet would run as a formula is quoted and starts with an apostrophe.
    expect(lines).toContain(
      `${tricky.url},org.example.tricky,"'=HYPERLINK(""https://evil.example""), ""quoted""",1.0.0,,verified,false,active,${tricky.firstRegisteredAt.toISOString()},${tricky.lastVerifiedAt!.toISOString()}`,
    )
    expect(lines).toContain(
      `${reported.url},com.globex.inventory,App 62,1.0.0,4+,phone_reported,true,archived,${reported.firstRegisteredAt.toISOString()},`,
    )
    // No account id leaves Core in the export.
    expect(reply.text).not.toContain("mu_alice")
  })

  test("is in the admin audit log", async () => {
    const admin = await organizationAdmin()
    await seedEntry()
    await call("GET", `${REGISTRY}/export`, {as: admin})
    const rows = await AdminActionAuditLogModel.find({action: "miniapp_registry.export"}).lean()
    expect(rows.map((row) => [row.adminId, row.targetType, row.targetId])).toEqual([[ADMIN_EMAIL, "miniapp_registry", "entries"]])
  })
})
