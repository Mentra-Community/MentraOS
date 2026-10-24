/**
 * @fileoverview Core's miniapp registry and the phone's calls: `POST /api/client/registry/register` and `/status`.
 *
 * Everything runs through the real app against a local replica set, with a fake in place of Core's fetcher
 * (`fetchMiniappManifest`): each test says what each URL serves. Miniapp tokens for sign-in challenges are minted by
 * the real token service, so the fake sees exactly the token a private server would get.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The database is
 * dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/miniapp-registry.integration.test.ts`
 */

import crypto from "node:crypto"

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {runStartupMigrations} from "../packages/core/src/migrations/startup.migrations"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import {
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
} from "../packages/core/src/models/miniapp-registry.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAssignedPackagesModel} from "../packages/core/src/models/workspace-assigned-packages.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import * as trustedEmail from "../packages/core/src/services/account/trusted-email.service"
import * as fetcher from "../packages/core/src/services/registry/miniapp-fetcher"
import type {MiniappFetchResult} from "../packages/core/src/services/registry/miniapp-fetcher"
import {
  archive,
  isArchived,
  reverificationsIdle,
  unarchive,
  type RegistryArchiveRule,
} from "../packages/core/src/services/registry/registry.service"
import * as session from "../packages/core/src/services/session.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {applyEnv} from "./support/signin-harness"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccountEmailModel,
  AuthRateLimitModel,
  LicenseModel,
  LicenseSeatModel,
  MiniappRegistryArchiveRuleModel,
  MiniappRegistryEntryModel,
  UserModel,
  WorkspaceAssignedPackagesModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const BASE = "https://core.test"
const NOTES_URL = "https://notes.example.com/"
const NOTES = "com.example.notes"
const ACME_URL = "https://tools.acme.com/"
const ACME_TOOLS = "com.acme.tools"
const INTRANET_URL = "https://intranet.globex.com/miniapps/"
const SHA = "AB".repeat(32)

/** Each account's verified email; null is an account without one. */
const EMAILS: Record<string, string | null> = {
  mu_alice: "alice@example.com",
  mu_bob: "bob@example.com",
  mu_carol: null,
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
/** Who the phone's access token names. */
let signedIn = "mu_alice"
const mocks: Array<{mockRestore(): void}> = []

/** What each URL serves to Core's fetcher, by request: the bearer is the challenge retry's token. */
type Serve = (request: {bearer?: string; claims: jose.JWTPayload | null}) => MiniappFetchResult | Promise<MiniappFetchResult>
let served: Map<string, Serve>
/** Every fetch Core made, in order. */
let fetches: Array<{url: string; bearer?: string; claims: jose.JWTPayload | null}>

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("miniapp-registry")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would
  // silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
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
    CLOUD_CORE_ENABLED_FEATURES: undefined,
    CLOUD_CORE_REGISTRY_STATUS_TTL_SEC: undefined,
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  })
  session.resetSigningKeyCache()
  signedIn = "mu_alice"
  served = new Map()
  fetches = []
  mocks.push(
    spyOn(trustedEmail, "trustedAccountEmail").mockImplementation(async (mentraUserId) => EMAILS[mentraUserId] ?? null),
    spyOn(session, "verifyAccessToken").mockImplementation(
      async () =>
        ({
          mentraUserId: signedIn,
          tenantId: "mentra",
          sessionId: "sess",
          jti: "jti",
          exp: Math.floor(Date.now() / 1000) + 300,
        }) as never,
    ),
    spyOn(fetcher, "fetchMiniappManifest").mockImplementation(async (url, options) => {
      const claims = options?.bearer ? jose.decodeJwt(options.bearer) : null
      fetches.push({url, ...(options?.bearer ? {bearer: options.bearer} : {}), claims})
      const serve = served.get(url)
      return serve ? serve({bearer: options?.bearer, claims}) : {kind: "unreachable", reason: "dns"}
    }),
  )
  assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
})

afterEach(async () => {
  await reverificationsIdle()
  setSystemTime()
  for (const mock of mocks.splice(0)) mock.mockRestore()
  restoreEnv()
  session.resetSigningKeyCache()
})

// --- Fixtures --------------------------------------------------------------

/** A served `miniapp.json`, with the fields the first-party manifests serve today. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    $schema: "https://miniapps.mentraglass.com/schema/miniapp.json",
    packageName: NOTES,
    version: "1.0.0",
    name: "Notes",
    description: "Take notes with your voice.",
    icon: "icon.png",
    ageRating: "4+",
    entry: {background: "background/index.js", ui: "ui/index.html"},
    bundle: {url: `${NOTES}-1.0.0.zip`, sha256: SHA},
    ...overrides,
  }
}

function ok(body: unknown, finalUrl: string): MiniappFetchResult {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {kind: "ok", manifest: {finalUrl, status: 200, body: text, etag: "\"v1\""}}
}

/** `url` serves `body` at `<url>/miniapp.json` to anyone. */
function serve(url: string, body: unknown, finalUrl = `${url}miniapp.json`): void {
  served.set(url, () => ok(body, finalUrl))
}

/** `url` asks for sign-in for `packageName` and serves `body` to a token `admit` accepts; others get 403. */
function servePrivate(url: string, packageName: string, body: unknown, admit: (claims: jose.JWTPayload) => boolean): void {
  served.set(url, ({claims}) => {
    if (!claims) return {kind: "challenge", packageName}
    return admit(claims) ? ok(body, `${url}miniapp.json`) : {kind: "refused", status: 403}
  })
}

const reported = (overrides: Record<string, unknown> = {}) => ({
  packageName: "com.globex.inventory",
  name: "Inventory",
  version: "2.1.0",
  ageRating: "13+",
  ...overrides,
})

async function call(path: string, body: unknown, options: {as?: string; raw?: string; auth?: boolean} = {}) {
  if (options.as) signedIn = options.as
  const response = await app.request(`${BASE}/api/client/registry/${path}`, {
    method: "POST",
    headers: {
      ...(options.auth === false ? {} : {Authorization: "Bearer access"}),
      "Content-Type": "application/json",
    },
    body: options.raw ?? JSON.stringify(body),
  })
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed assertion on `json`.
  }
  return {status: response.status, json, headers: response.headers}
}

async function register(body: unknown, as?: string) {
  const answer = await call("register", body, as ? {as} : {})
  expect(answer.status).toBe(200)
  return answer.json
}

async function status(entries: Array<{url: string; version: string}>, as?: string) {
  const answer = await call("status", {entries}, as ? {as} : {})
  expect(answer.status).toBe(200)
  return answer.json
}

const entryRow = (url: string) => MiniappRegistryEntryModel.findOne({url}).lean()

async function workspaceAssigning(workspaceId: string, mentraUserId: string, packageNames: string[]): Promise<void> {
  await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId: `wm_${workspaceId}_${mentraUserId}`,
      workspaceId,
      mentraUserId,
      role: "owner",
      status: "active",
      startedAt: new Date(Date.now() - 60_000),
    }),
  )
  await WorkspaceAssignedPackagesModel.create({workspaceId, packageNames, revision: 1})
}

const rule = (kind: RegistryArchiveRule["kind"], value: string) => ({kind, value})
const by = {reason: "test", createdBy: "admin@example.com"}

// --- Who may register --------------------------------------------------------

describe("who may register", () => {
  test("a phone without a valid access token is 401", async () => {
    const answer = await call("register", {url: NOTES_URL}, {auth: false})
    expect(answer.status).toBe(401)
    expect((await call("status", {entries: []}, {auth: false})).status).toBe(401)
    expect(fetches).toEqual([])
  })

  test("a deleted account is 401", async () => {
    await UserModel.create({
      mentraUserId: "mu_alice",
      tenantId: "mentra",
      tenantUserId: "gotrue-alice",
      supportTelemetryDeletedAt: new Date(),
    })
    serve(NOTES_URL, manifest())
    expect((await call("register", {url: NOTES_URL})).status).toBe(401)
    expect(fetches).toEqual([])
  })

  test("an account without a verified email is 403 email_unverified, and Core reads nothing", async () => {
    serve(NOTES_URL, manifest())
    const answer = await call("register", {url: NOTES_URL}, {as: "mu_carol"})
    expect({status: answer.status, error: answer.json?.error}).toEqual({status: 403, error: "email_unverified"})
    expect(fetches).toEqual([])
    expect(await entryRow(NOTES_URL)).toBeNull()
  })

  test("an archived URL, or one that can't be a miniapp, is answered for any signed-in phone", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    await archive(rule("url", NOTES_URL), by)
    await archive(rule("domain", "acme.com"), by)
    await archive(rule("package", "com.globex.inventory"), by)
    const before = fetches.length

    // No verified email, and the directory unreachable for good measure: archiving still holds.
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockRejectedValue(new Error("directory down")))
    for (const as of ["mu_carol", "mu_dave"]) {
      expect(await register({url: NOTES_URL}, as)).toEqual({result: "archived"})
      expect(await register({url: "https://never.acme.com/"}, as)).toEqual({result: "archived"})
      // A new URL whose reported package is archived.
      expect(await register({url: INTRANET_URL, reported: reported()}, as)).toEqual({result: "archived"})
      expect(await register({url: "http://notes.example.com/"}, as)).toEqual({result: "not_a_miniapp", reason: "not_https"})
    }
    expect(fetches).toHaveLength(before)
  })

  test("is 503 when the account directory can't say, with no copy of the email", async () => {
    mocks.push(spyOn(trustedEmail, "trustedAccountEmail").mockRejectedValue(new Error("directory down")))
    const answer = await call("register", {url: NOTES_URL})
    expect({status: answer.status, error: answer.json?.error}).toEqual({status: 503, error: "unavailable"})
  })

  test("an account registers at most 120 URLs an hour, then 429 with Retry-After until the window ends", async () => {
    setSystemTime(new Date("2026-10-24T12:30:00.000Z"))
    const windowStart = Date.parse("2026-10-24T12:00:00.000Z")
    await AuthRateLimitModel.create({
      _id: `miniapp-registry:mu_alice:${windowStart}`,
      count: 119,
      windowEndsAt: new Date(windowStart + 3_600_000),
    })
    serve(NOTES_URL, manifest())

    expect((await register({url: NOTES_URL})).result).toBe("accepted")
    const limited = await call("register", {url: NOTES_URL})
    expect({status: limited.status, error: limited.json?.error}).toEqual({status: 429, error: "rate_limited"})
    expect(limited.headers.get("retry-after")).toBe("1800")
    expect(fetches).toHaveLength(1)
    // Another account has its own allowance.
    expect((await register({url: NOTES_URL}, "mu_bob")).result).toBe("accepted")
    // Past the limit, an archived URL is still answered.
    await archive(rule("url", NOTES_URL), by)
    expect(await register({url: NOTES_URL}, "mu_alice")).toEqual({result: "archived"})
  })

  test("a malformed body is 400 invalid_request", async () => {
    for (const raw of ["not json", "[]", "{}", JSON.stringify({url: 7})]) {
      const answer = await call("register", null, {raw})
      expect({raw, status: answer.status, error: answer.json?.error}).toEqual({raw, status: 400, error: "invalid_request"})
    }
    for (const body of [
      {url: "https://notes.example.com/?key=1"},
      {url: "https://user:pass@notes.example.com/"},
      {url: "ftp://notes.example.com/"},
      {url: NOTES_URL, reported: {packageName: "Not A Package", name: "x", version: "1.0.0"}},
      {url: NOTES_URL, reported: {packageName: NOTES, name: "Notes", version: "v1"}},
      {url: NOTES_URL, reported: {packageName: NOTES, name: "Notes", version: "1.0.0", ageRating: "21+"}},
    ]) {
      const answer = await call("register", body)
      expect({body, status: answer.status, error: answer.json?.error}).toEqual({body, status: 400, error: "invalid_request"})
    }
    expect(fetches).toEqual([])
  })
})

// --- Verifying a registration --------------------------------------------------

describe("verifying a registration", () => {
  test("accepted: Core keeps what it read, and the phone gets Core's verified copy", async () => {
    serve(NOTES_URL, manifest())
    const answer = await register({url: "HTTPS://Notes.Example.com", reported: reported({packageName: NOTES})})

    expect(answer.result).toBe("accepted")
    expect(answer.entry).toEqual({
      url: NOTES_URL,
      packageName: NOTES,
      registrableDomain: "example.com",
      name: "Notes",
      version: "1.0.0",
      ageRating: "4+",
      iconUrl: "https://notes.example.com/icon.png",
      verification: "verified",
      private: false,
      status: "active",
      firstRegisteredAt: expect.any(String),
      lastVerifiedAt: expect.any(String),
    })
    // Fields the schema doesn't name are kept as served; the SHA-256 is read in lowercase.
    expect(answer.manifest).toMatchObject({$schema: expect.any(String), entry: {ui: "ui/index.html"}})
    expect(answer.manifest.bundle.sha256).toBe(SHA.toLowerCase())
    // A public URL is read once, with no token.
    expect(fetches).toEqual([{url: NOTES_URL, claims: null}])

    const row = await entryRow(NOTES_URL)
    expect(row).toMatchObject({verification: "verified", firstRegisteredBy: "mu_alice", lastSeenVersion: "1.0.0"})
    expect(JSON.parse(row!.manifest!)).toEqual(answer.manifest)
  })

  test("a redirect to another host on the URL's domain is verified", async () => {
    serve(NOTES_URL, manifest(), "https://cdn.example.com/notes/miniapp.json")
    expect((await register({url: NOTES_URL})).result).toBe("accepted")
  })

  test("a later registration keeps the first registrant and records the new version", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    serve(NOTES_URL, manifest({version: "1.1.0"}))
    const answer = await register({url: NOTES_URL}, "mu_bob")
    expect(answer.entry.version).toBe("1.1.0")
    expect(await entryRow(NOTES_URL)).toMatchObject({firstRegisteredBy: "mu_alice", lastSeenVersion: "1.1.0"})
    expect(await MiniappRegistryEntryModel.countDocuments({})).toBe(1)
  })

  test("an invalid miniapp.json doesn't register", async () => {
    for (const body of [
      "<html>Sign in</html>",
      manifest({bundle: undefined}),
      manifest({version: "v1"}),
      manifest({ageRating: "21+"}),
    ]) {
      serve(NOTES_URL, body)
      expect(await register({url: NOTES_URL, reported: reported({packageName: NOTES})})).toEqual({
        result: "not_a_miniapp",
        reason: "invalid_manifest",
      })
    }
    expect(await entryRow(NOTES_URL)).toBeNull()
  })

  test("a URL whose server says nothing is there (404, 410) doesn't register", async () => {
    for (const code of [404, 410]) {
      served.set(NOTES_URL, () => ({kind: "refused", status: code}))
      expect(await register({url: NOTES_URL, reported: reported({packageName: NOTES})})).toEqual({
        result: "not_a_miniapp",
        reason: "invalid_manifest",
      })
    }
    expect(await entryRow(NOTES_URL)).toBeNull()
  })

  test("a name that doesn't match the URL's domain doesn't register", async () => {
    for (const packageName of ["com.other.notes", "com.mentra.notes", "com.example"]) {
      serve(NOTES_URL, manifest({packageName}))
      expect(await register({url: NOTES_URL})).toEqual({result: "not_a_miniapp", reason: "domain_mismatch"})
    }
    expect(await entryRow(NOTES_URL)).toBeNull()
  })

  test("com.mentra.* registers from mentraglass.com", async () => {
    const url = "https://miniapps.mentraglass.com/com.mentra.notes/"
    serve(url, manifest({packageName: "com.mentra.notes"}))
    expect((await register({url})).entry).toMatchObject({packageName: "com.mentra.notes", registrableDomain: "mentraglass.com"})
  })

  test("HTTP, local-network and IP-address URLs are refused without being read", async () => {
    expect(await register({url: "http://notes.example.com/"})).toEqual({result: "not_a_miniapp", reason: "not_https"})
    for (const url of ["http://192.168.1.10:8080/", "https://printer.local/", "http://localhost:3000/", "https://[fd00::1]/"]) {
      expect(await register({url})).toEqual({result: "not_a_miniapp", reason: "local_network_url"})
    }
    expect(await register({url: "https://8.8.8.8/"})).toEqual({result: "not_a_miniapp", reason: "domain_mismatch"})
    expect(await register({url: "https://notes.internal/"})).toEqual({result: "not_a_miniapp", reason: "domain_mismatch"})
    expect(fetches).toEqual([])
    expect(await MiniappRegistryEntryModel.countDocuments({})).toBe(0)
  })
})

// --- URLs only the phone can reach -------------------------------------------

describe("URLs Core can't reach", () => {
  test("are recorded from the phone's report, as reported by a phone", async () => {
    const answer = await register({url: INTRANET_URL, reported: reported()})
    expect(answer).toEqual({
      result: "accepted_unverified",
      entry: {
        url: INTRANET_URL,
        packageName: "com.globex.inventory",
        registrableDomain: "globex.com",
        name: "Inventory",
        version: "2.1.0",
        ageRating: "13+",
        iconUrl: null,
        verification: "phone_reported",
        private: false,
        status: "active",
        firstRegisteredAt: expect.any(String),
        lastVerifiedAt: null,
      },
    })
    expect(await entryRow(INTRANET_URL)).toMatchObject({manifest: null, lastSeenVersion: "2.1.0", firstRegisteredBy: "mu_alice"})
  })

  test("without a report, aren't a miniapp, and nothing is recorded", async () => {
    expect(await register({url: INTRANET_URL})).toEqual({result: "not_a_miniapp", reason: "invalid_manifest"})
    expect(await entryRow(INTRANET_URL)).toBeNull()
  })

  test("a report whose name fails the domain rule is refused", async () => {
    expect(await register({url: INTRANET_URL, reported: reported({packageName: "com.example.inventory"})})).toEqual({
      result: "not_a_miniapp",
      reason: "domain_mismatch",
    })
    expect(await entryRow(INTRANET_URL)).toBeNull()
  })

  test("a host that resolves to a private address, a server that turns Core away, or a redirect off the domain count as unreachable", async () => {
    const cases: Array<[string, Serve]> = [
      ["https://a.globex.com/", () => ({kind: "unreachable", reason: "private_address"})],
      ["https://b.globex.com/", () => ({kind: "refused", status: 403})],
      ["https://c.globex.com/", () => ({kind: "refused", status: 401})],
      ["https://d.globex.com/", () => ok("<html>Sign in</html>", "https://login.identity-provider.com/start")],
      ["https://e.globex.com/", () => ({kind: "unreachable", reason: "bad_url"})],
    ]
    for (const [url, result] of cases) {
      served.set(url, result)
      expect({url, answer: (await register({url, reported: reported()})).result}).toEqual({url, answer: "accepted_unverified"})
    }
  })

  test("a later report updates a phone-reported entry, and Core verifies it once it can read it", async () => {
    await register({url: INTRANET_URL, reported: reported()})
    expect((await register({url: INTRANET_URL, reported: reported({version: "2.2.0"})})).entry.version).toBe("2.2.0")

    serve(INTRANET_URL, manifest({packageName: "com.globex.inventory", name: "Inventory", version: "2.3.0"}))
    const answer = await register({url: INTRANET_URL, reported: reported({version: "2.3.0"})})
    expect(answer.result).toBe("accepted")
    expect(answer.entry).toMatchObject({verification: "verified", version: "2.3.0"})
  })

  test("a verified entry isn't replaced by a phone's report when Core can't read the URL later", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    served.delete(NOTES_URL)

    const answer = await register({url: NOTES_URL, reported: reported({packageName: "com.example.fake", name: "Fake"})})
    expect(answer).toMatchObject({result: "accepted_unverified", entry: {verification: "verified", name: "Notes"}})
    expect(await entryRow(NOTES_URL)).toMatchObject({packageName: NOTES, name: "Notes", verification: "verified"})
  })
})

// --- Private miniapps ----------------------------------------------------------

describe("private miniapps", () => {
  test("Core answers the challenge with the person's token for that package, and records the URL as private", async () => {
    await workspaceAssigning("ws_acme", "mu_alice", [ACME_TOOLS])
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS, name: "Acme Tools"}), (claims) => claims.workspaceId === "ws_acme")

    const answer = await register({url: ACME_URL})
    expect(answer.result).toBe("accepted")
    expect(answer.entry).toMatchObject({packageName: ACME_TOOLS, name: "Acme Tools", private: true, verification: "verified"})

    // One read without a token, one retry with the token for exactly that package.
    expect(fetches.map((fetch) => [fetch.url, fetch.bearer !== undefined])).toEqual([
      [ACME_URL, false],
      [ACME_URL, true],
    ])
    expect(fetches[1]!.claims).toMatchObject({aud: ACME_TOOLS, sub: "mu_alice", workspaceId: "ws_acme"})
    const pem = `-----BEGIN PUBLIC KEY-----\n${process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
    await jose.jwtVerify(fetches[1]!.bearer!, await jose.importSPKI(pem, "EdDSA"), {audience: ACME_TOOLS})
  })

  test("a token names no workspace for a package the person's workspace didn't assign", async () => {
    await workspaceAssigning("ws_acme", "mu_alice", ["com.acme.other"])
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS}), () => true)
    await register({url: ACME_URL})
    expect("workspaceId" in fetches[1]!.claims!).toBe(false)
  })

  test("a server that refuses the token is recorded as private with only its challenge's package", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS}), () => false)

    const answer = await register({url: ACME_URL, reported: reported({packageName: ACME_TOOLS, name: "Phone's name"})})
    expect(answer).toEqual({
      result: "accepted_unverified",
      entry: {
        url: ACME_URL,
        packageName: ACME_TOOLS,
        registrableDomain: "acme.com",
        name: null,
        version: null,
        ageRating: null,
        iconUrl: null,
        verification: "phone_reported",
        private: true,
        status: "active",
        firstRegisteredAt: expect.any(String),
        lastVerifiedAt: null,
      },
    })
    expect(await entryRow(ACME_URL)).toMatchObject({name: null, version: null, manifest: null, private: true})
  })

  test("a challenge naming a package outside the URL's domain gets no token", async () => {
    served.set(ACME_URL, () => ({kind: "challenge", packageName: "com.mentra.notes"}))
    expect(await register({url: ACME_URL, reported: reported({packageName: ACME_TOOLS})})).toEqual({
      result: "not_a_miniapp",
      reason: "domain_mismatch",
    })
    expect(fetches).toHaveLength(1)
  })

  test("a manifest for another package than the challenge named isn't the miniapp", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: "com.acme.other"}), () => true)
    expect(await register({url: ACME_URL})).toEqual({result: "not_a_miniapp", reason: "invalid_manifest"})
  })

  test("someone the server turns away sees no details, and the verified entry keeps them", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS, name: "Acme Tools"}), (claims) => claims.sub === "mu_alice")
    expect((await register({url: ACME_URL})).result).toBe("accepted")

    const bob = await register({url: ACME_URL}, "mu_bob")
    expect(bob.result).toBe("accepted_unverified")
    expect(bob.entry).toMatchObject({packageName: ACME_TOOLS, name: null, iconUrl: null, version: null, private: true, verification: "verified"})
    expect(await entryRow(ACME_URL)).toMatchObject({name: "Acme Tools", verification: "verified", private: true})

    // Unreachable later: still no details for anyone, and nothing replaced.
    served.delete(ACME_URL)
    const later = await register({url: ACME_URL, reported: reported({packageName: ACME_TOOLS, name: "Other"})}, "mu_alice")
    expect(later).toMatchObject({result: "accepted_unverified", entry: {name: null}})
    expect(await entryRow(ACME_URL)).toMatchObject({name: "Acme Tools"})
  })

  test("a public URL that starts asking for sign-in becomes private", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    servePrivate(NOTES_URL, NOTES, manifest(), () => false)
    expect((await register({url: NOTES_URL})).entry).toMatchObject({private: true, name: null})
    expect(await entryRow(NOTES_URL)).toMatchObject({private: true, verification: "verified", name: "Notes"})
  })
})

// --- Archiving -----------------------------------------------------------------

describe("archiving", () => {
  test("a URL rule refuses the URL without reading it", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    const fetchesBefore = fetches.length

    expect(await archive(rule("url", "https://NOTES.example.com"), by)).toMatchObject({created: true, entriesArchived: 1})
    expect(await register({url: NOTES_URL})).toEqual({result: "archived"})
    expect(fetches).toHaveLength(fetchesBefore)
    expect(await entryRow(NOTES_URL)).toMatchObject({status: "archived"})
  })

  test("a package rule covers every URL serving the package, including one registered after it", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    await archive(rule("package", NOTES), by)
    expect(await register({url: NOTES_URL})).toEqual({result: "archived"})

    const mirror = "https://mirror.example.com/notes/"
    serve(mirror, manifest())
    expect(await register({url: mirror})).toEqual({result: "archived"})
    expect(await entryRow(mirror)).toBeNull()
    // Phone-reported too.
    expect(await register({url: "https://intranet.example.com/", reported: reported({packageName: NOTES})})).toEqual({
      result: "archived",
    })
  })

  test("a domain rule refuses a URL on the domain registered after it, without reading it", async () => {
    await archive(rule("domain", "Example.com."), by)
    serve("https://new.example.com/", manifest())
    expect(await register({url: "https://new.example.com/"})).toEqual({result: "archived"})
    expect(fetches).toEqual([])
    expect(await MiniappRegistryEntryModel.countDocuments({})).toBe(0)

    // Another domain is unaffected.
    serve(ACME_URL, manifest({packageName: ACME_TOOLS}))
    expect((await register({url: ACME_URL})).result).toBe("accepted")
  })

  test("an account rule covers what the account registered, before and after it", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL}, "mu_bob")
    serve(ACME_URL, manifest({packageName: ACME_TOOLS}))
    await register({url: ACME_URL}, "mu_alice")

    expect((await archive(rule("account", "mu_bob"), by)).entriesArchived).toBe(1)
    // Bob's entry is archived for everyone; Bob's new URLs are refused.
    expect(await register({url: NOTES_URL}, "mu_alice")).toEqual({result: "archived"})
    serve("https://other.example.com/", manifest())
    expect(await register({url: "https://other.example.com/"}, "mu_bob")).toEqual({result: "archived"})
    expect(await entryRow("https://other.example.com/")).toBeNull()
    // Someone else's entry stays available to Bob's phone.
    expect((await register({url: ACME_URL}, "mu_bob")).result).toBe("accepted")
  })

  test("each rule kind archives in the status answer, and unarchiving restores what no other rule covers", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL}, "mu_bob")
    const statusOf = async () => (await status([{url: NOTES_URL, version: "1.0.0"}])).statuses[0].status

    for (const r of [rule("url", NOTES_URL), rule("package", NOTES), rule("domain", "example.com"), rule("account", "mu_bob")]) {
      await archive(r, by)
      expect({rule: r, status: await statusOf()}).toEqual({rule: r, status: "archived"})
      expect(await unarchive(r)).toMatchObject({removed: true, entriesRestored: 1})
      expect({rule: r, status: await statusOf()}).toEqual({rule: r, status: "active"})
    }

    await archive(rule("package", NOTES), by)
    await archive(rule("domain", "example.com"), by)
    expect((await unarchive(rule("package", NOTES))).entriesRestored).toBe(0)
    expect(await statusOf()).toBe("archived")
    expect((await unarchive(rule("domain", "example.com"))).entriesRestored).toBe(1)
    expect(await statusOf()).toBe("active")
  })

  test("a rule is decisive even where the entry's status wasn't set", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    await MiniappRegistryArchiveRuleModel.create({kind: "domain", value: "example.com", createdBy: "x", createdAt: new Date()})
    const row = await entryRow(NOTES_URL)
    expect(row!.status).toBe("active")
    expect(await isArchived(row! as never)).toBe(true)
    expect(await register({url: NOTES_URL})).toEqual({result: "archived"})
  })

  test("archiving twice keeps the first rule, and an invalid rule is refused", async () => {
    expect((await archive(rule("domain", "example.com"), by)).created).toBe(true)
    expect((await archive(rule("domain", "example.com"), {reason: "again", createdBy: "b"})).created).toBe(false)
    expect(await MiniappRegistryArchiveRuleModel.findOne({kind: "domain"}).lean()).toMatchObject({reason: "test"})
    for (const bad of [rule("domain", "notes.example.com"), rule("domain", "com"), rule("url", "http://x.example.com/"), rule("package", "Bad")]) {
      await expect(archive(bad, by)).rejects.toThrow()
    }
  })
})

// --- Status ----------------------------------------------------------------------

describe("the status batch", () => {
  test("answers each URL in order, as the phone sent it", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    serve(ACME_URL, manifest({packageName: ACME_TOOLS}))
    await register({url: ACME_URL})
    await archive(rule("url", ACME_URL), by)

    const answer = await status([
      {url: "https://notes.example.com", version: "1.0.0"},
      {url: ACME_URL, version: "1.0.0"},
      {url: "https://unknown.example.com/", version: "1.0.0"},
      {url: "http://192.168.1.2:8080/", version: "1.0.0"},
      {url: "not a url", version: "1.0.0"},
      {url: NOTES_URL, version: "1.0.0"},
    ])
    expect(answer).toEqual({
      statuses: [
        {url: "https://notes.example.com", status: "active"},
        {url: ACME_URL, status: "archived"},
        {url: "https://unknown.example.com/", status: "unknown"},
        {url: "http://192.168.1.2:8080/", status: "unknown"},
        {url: "not a url", status: "unknown"},
        {url: NOTES_URL, status: "active"},
      ],
      validForSeconds: 21600,
    })
    expect(await status([])).toEqual({statuses: [], validForSeconds: 21600})
  })

  test("validForSeconds comes from CLOUD_CORE_REGISTRY_STATUS_TTL_SEC", async () => {
    process.env.CLOUD_CORE_REGISTRY_STATUS_TTL_SEC = "900"
    expect((await status([])).validForSeconds).toBe(900)
    process.env.CLOUD_CORE_REGISTRY_STATUS_TTL_SEC = "soon"
    expect((await status([])).validForSeconds).toBe(21600)
  })

  test("takes at most 500 entries", async () => {
    const entries = Array.from({length: 501}, (_, index) => ({url: `https://n${index}.example.com/`, version: "1.0.0"}))
    const answer = await call("status", {entries})
    expect({status: answer.status, error: answer.json?.error}).toEqual({status: 400, error: "invalid_request"})
    expect((await status(entries.slice(0, 500))).statuses).toHaveLength(500)
  })

  test("answers a phone without a verified email, but doesn't read URLs for it", async () => {
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    setSystemTime(new Date(Date.now() + 2 * 3_600_000))
    serve(NOTES_URL, manifest({version: "2.0.0"}))
    const before = fetches.length

    expect((await status([{url: NOTES_URL, version: "2.0.0"}], "mu_carol")).statuses[0].status).toBe("active")
    await reverificationsIdle()
    expect(fetches).toHaveLength(before)
  })
})

describe("re-verification", () => {
  test("a version Core hasn't seen re-reads the URL off the request path, at most once an hour", async () => {
    const start = new Date("2026-10-24T08:00:00.000Z")
    setSystemTime(start)
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    expect(fetches).toHaveLength(1)

    // Within the hour of the last read: nothing.
    setSystemTime(new Date(start.getTime() + 10 * 60_000))
    serve(NOTES_URL, manifest({version: "1.1.0"}))
    await status([{url: NOTES_URL, version: "1.1.0"}])
    await reverificationsIdle()
    expect(fetches).toHaveLength(1)

    // An hour later: the newer version re-reads it, and the status answer doesn't wait for the read.
    setSystemTime(new Date(start.getTime() + 61 * 60_000))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    served.set(NOTES_URL, async () => {
      await gate
      return ok(manifest({version: "1.1.0"}), `${NOTES_URL}miniapp.json`)
    })
    const answer = await status([
      {url: NOTES_URL, version: "1.1.0"},
      {url: NOTES_URL, version: "1.1.0"},
    ])
    expect(answer.statuses[0].status).toBe("active")
    expect((await entryRow(NOTES_URL))!.version).toBe("1.0.0")
    release()
    await reverificationsIdle()
    expect(fetches).toHaveLength(2)
    expect(await entryRow(NOTES_URL)).toMatchObject({version: "1.1.0", lastSeenVersion: "1.1.0"})

    // The same or an older version never does; a newer one waits for the hour.
    setSystemTime(new Date(start.getTime() + 5 * 3_600_000))
    await status([{url: NOTES_URL, version: "1.1.0"}, {url: NOTES_URL, version: "1.0.0"}, {url: NOTES_URL, version: "1.1.0-beta.1"}])
    await reverificationsIdle()
    expect(fetches).toHaveLength(2)
    await status([{url: NOTES_URL, version: "1.2.0"}])
    await status([{url: NOTES_URL, version: "1.3.0"}])
    await reverificationsIdle()
    expect(fetches).toHaveLength(3)
  })

  test("an entry Core couldn't read is retried hourly and becomes verified when it can", async () => {
    const start = new Date("2026-10-24T08:00:00.000Z")
    setSystemTime(start)
    await register({url: INTRANET_URL, reported: reported()})
    setSystemTime(new Date(start.getTime() + 61 * 60_000))
    await status([{url: INTRANET_URL, version: "2.1.0"}])
    await reverificationsIdle()
    expect(fetches).toHaveLength(2)
    expect((await entryRow(INTRANET_URL))!.verification).toBe("phone_reported")

    setSystemTime(new Date(start.getTime() + 125 * 60_000))
    serve(INTRANET_URL, manifest({packageName: "com.globex.inventory", name: "Inventory", version: "2.1.0"}))
    await status([{url: INTRANET_URL, version: "2.1.0"}])
    await reverificationsIdle()
    expect(await entryRow(INTRANET_URL)).toMatchObject({verification: "verified", name: "Inventory"})
  })

  test("a private URL is re-read with the token of the person whose phone asked", async () => {
    const start = new Date("2026-10-24T08:00:00.000Z")
    setSystemTime(start)
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS}), () => true)
    await register({url: ACME_URL})
    setSystemTime(new Date(start.getTime() + 61 * 60_000))
    servePrivate(ACME_URL, ACME_TOOLS, manifest({packageName: ACME_TOOLS, version: "1.1.0"}), () => true)
    await status([{url: ACME_URL, version: "1.1.0"}], "mu_bob")
    await reverificationsIdle()
    expect(fetches.at(-1)!.claims).toMatchObject({sub: "mu_bob", aud: ACME_TOOLS})
    expect((await entryRow(ACME_URL))!.version).toBe("1.1.0")
  })

  test("an archived entry is never re-read", async () => {
    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    await register({url: INTRANET_URL, reported: reported()})
    await archive(rule("domain", "globex.com"), by)
    setSystemTime(new Date("2026-10-24T10:00:00.000Z"))
    await status([{url: INTRANET_URL, version: "9.0.0"}])
    await reverificationsIdle()
    expect(fetches).toHaveLength(1)
  })
})

// --- Races ---------------------------------------------------------------------

/** A read held until `release()`; `reached` resolves once Core is waiting on it. */
function heldRead(answer: Serve) {
  let release: () => void = () => {}
  let arrived: () => void = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  const reached = new Promise<void>((resolve) => (arrived = resolve))
  const serve: Serve = async (request) => {
    arrived()
    await released
    return answer(request)
  }
  return {serve, reached, release}
}

describe("races", () => {
  test("a rule made while Core reads an unreachable URL refuses the install", async () => {
    // A verified entry, and one only a phone reported, each answered from what Core already holds.
    serve(NOTES_URL, manifest())
    await register({url: NOTES_URL})
    await register({url: INTRANET_URL, reported: reported()})
    for (const [url, body] of [
      [NOTES_URL, {url: NOTES_URL, reported: reported({packageName: NOTES})}],
      [INTRANET_URL, {url: INTRANET_URL}],
    ] as const) {
      const read = heldRead(() => ({kind: "unreachable", reason: "timeout"}))
      served.set(url, read.serve)
      const pending = call("register", body)
      await read.reached
      await archive(rule("url", url), by)
      read.release()
      expect({url, answer: (await pending).json}).toEqual({url, answer: {result: "archived"}})
    }
  })

  test("a rule made while Core reads a URL it verifies refuses the install", async () => {
    const read = heldRead(() => ok(manifest(), `${NOTES_URL}miniapp.json`))
    served.set(NOTES_URL, read.serve)

    const pending = call("register", {url: NOTES_URL})
    await read.reached
    await archive(rule("account", "mu_alice"), by)
    read.release()

    expect((await pending).json).toEqual({result: "archived"})
    expect(await entryRow(NOTES_URL)).toBeNull()
  })

  test("a public read that lands after a private one answers what it read, not the private entry", async () => {
    const start = new Date("2026-10-24T08:00:00.000Z")
    setSystemTime(start)
    // Alice is served the public file; her read is held while Bob's later read is admitted to the private one.
    const aliceRead = heldRead(() => ok(manifest({name: "Notes"}), `${NOTES_URL}miniapp.json`))
    served.set(NOTES_URL, aliceRead.serve)
    const alice = call("register", {url: NOTES_URL}, {as: "mu_alice"})
    await aliceRead.reached

    setSystemTime(new Date(start.getTime() + 1_000))
    servePrivate(NOTES_URL, NOTES, manifest({name: "Secret Notes", version: "9.0.0", icon: "secret.png"}), () => true)
    const bob = await register({url: NOTES_URL}, "mu_bob")
    expect(bob.entry).toMatchObject({name: "Secret Notes", private: true})

    aliceRead.release()
    const answer = (await alice).json
    expect(answer.result).toBe("accepted")
    expect(answer.entry).toMatchObject({name: "Notes", version: "1.0.0", private: false, iconUrl: `${NOTES_URL}icon.png`})
    expect(answer.manifest.name).toBe("Notes")
    // The later read is what Core keeps.
    expect(await entryRow(NOTES_URL)).toMatchObject({name: "Secret Notes", private: true})
  })
})

describe("startup migrations", () => {
  test("build the registry's collections and indexes", async () => {
    assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
    for (const model of [MiniappRegistryEntryModel, MiniappRegistryArchiveRuleModel]) {
      await model.collection.drop().catch(() => undefined)
    }
    await runStartupMigrations()
    for (const model of [MiniappRegistryEntryModel, MiniappRegistryArchiveRuleModel]) {
      const built = await model.collection.indexes()
      const keys = built.map((index) => JSON.stringify(index.key))
      for (const [fields, options] of model.schema.indexes()) {
        expect({model: model.modelName, fields, has: keys.includes(JSON.stringify(fields))}).toEqual({
          model: model.modelName,
          fields,
          has: true,
        })
        if (options.unique) {
          expect(built.find((index) => JSON.stringify(index.key) === JSON.stringify(fields))?.unique).toBe(true)
        }
      }
    }
  })
})
