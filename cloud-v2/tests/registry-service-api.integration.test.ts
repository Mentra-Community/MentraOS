/**
 * @fileoverview The miniapp registry's signed service API: Fleet's `POST /api/internal/registry/check` and `/lookup`,
 * and the directory's `GET /api/internal/registry/entries` and `POST /archive`.
 *
 * Everything runs through the real app against a local replica set, signed as Fleet and the Store sign, with a fake
 * in place of Core's fetcher (`fetchMiniappManifest`): each test says what each URL serves. Miniapp tokens for
 * sign-in challenges are minted by the real token service, so the fake sees exactly the token a private server
 * would get.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The database is
 * dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/registry-service-api.integration.test.ts`
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
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {AdminActionAuditLogModel} from "../packages/core/src/models/admin-action-audit-log.model"
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
import {registryChecksIdle} from "../packages/core/src/services/registry/registry-service-api.service"
import {
  archive,
  registerMiniappUrl,
  reverificationsIdle,
  type RegistryArchiveRule,
} from "../packages/core/src/services/registry/registry.service"
import * as session from "../packages/core/src/services/session.service"
import {createCoreWorkspaceClient, SERVICE_HEADERS, signServiceRequest} from "../packages/workspace-contract/src/server"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {applyEnv} from "./support/signin-harness"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default; the
// check's own deadline is 10 s.
setDefaultTimeout(40_000)

const MODELS = [
  AccountEmailModel,
  AdminActionAuditLogModel,
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

const SERVICE_SECRETS = {store: ["store-s1"], fleet: ["fleet-f1"]}
const BASE = "https://core.test"
const NOTES_URL = "https://notes.example.com/"
const NOTES = "com.example.notes"
const ACME_URL = "https://tools.acme.com/"
const ACME_TOOLS = "com.acme.tools"
const INTRANET_URL = "https://intranet.globex.com/miniapps/"
const SHA = "AB".repeat(32)
const ADMIN = "mu_admin"
const OTHER_ADMIN = "mu_other"

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
const mocks: Array<{mockRestore(): void}> = []

/** What each URL serves to Core's fetcher, by request: the bearer is the challenge retry's token. */
type Serve = (request: {
  bearer?: string
  claims: jose.JWTPayload | null
}) => MiniappFetchResult | Promise<MiniappFetchResult>
let served: Map<string, Serve>
/** Every fetch Core made, in order. */
let fetches: Array<{url: string; bearer?: string; claims: jose.JWTPayload | null}>
/** Fetches still being served, so a test can hold some and let them go at the end. */
let held: Array<() => void>

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("registry-service-api")
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
    CLOUD_CORE_SERVICE_SECRETS: JSON.stringify(SERVICE_SECRETS),
    CLOUD_CORE_ENABLED_FEATURES: undefined,
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  })
  session.resetSigningKeyCache()
  served = new Map()
  fetches = []
  held = []
  mocks.push(
    // No account has a verified email: Fleet's check doesn't need one.
    spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null),
    spyOn(fetcher, "fetchMiniappManifest").mockImplementation(async (url, options) => {
      const claims = options?.bearer ? jose.decodeJwt(options.bearer) : null
      fetches.push({url, ...(options?.bearer ? {bearer: options.bearer} : {}), claims})
      const serve = served.get(url)
      return serve ? serve({bearer: options?.bearer, claims}) : {kind: "unreachable", reason: "dns"}
    }),
  )
  assertConnectedTo(databaseUrl, MiniappRegistryEntryModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
  await workspace("ws_acme", ADMIN)
  await workspace("ws_globex", OTHER_ADMIN)
})

afterEach(async () => {
  for (const release of held.splice(0)) release()
  await registryChecksIdle()
  await reverificationsIdle()
  setSystemTime()
  for (const mock of mocks.splice(0)) mock.mockRestore()
  restoreEnv()
  session.resetSigningKeyCache()
})

// --- Fixtures --------------------------------------------------------------

async function workspace(workspaceId: string, owner: string): Promise<void> {
  await UserModel.create({mentraUserId: owner, tenantId: "mentra", tenantUserId: `gotrue-${owner}`})
  await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId: `wm_${workspaceId}_${owner}`,
      workspaceId,
      mentraUserId: owner,
      role: "owner",
      status: "active",
      startedAt: new Date(Date.now() - 60_000),
    }),
  )
}

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

const acmeManifest = () => manifest({packageName: ACME_TOOLS, name: "Acme Tools", ageRating: undefined})

function ok(body: unknown, finalUrl: string): MiniappFetchResult {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return {kind: "ok", manifest: {finalUrl, status: 200, body: text, etag: '"v1"'}}
}

/** `url` serves `body` at `<url>/miniapp.json` to anyone. */
function serve(url: string, body: unknown): void {
  served.set(url, () => ok(body, `${url}miniapp.json`))
}

/** `url` asks for sign-in for `packageName` and serves `body` to a token `admit` accepts; others get 403. */
function servePrivate(
  url: string,
  packageName: string,
  body: unknown,
  admit: (claims: jose.JWTPayload) => boolean,
): void {
  served.set(url, ({claims}) => {
    if (!claims) return {kind: "challenge", packageName}
    return admit(claims) ? ok(body, `${url}miniapp.json`) : {kind: "refused", status: 403}
  })
}

const reported = (overrides: Record<string, unknown> = {}) => ({
  packageName: "com.globex.inventory",
  name: "Inventory",
  version: "2.1.0",
  ageRating: "13+" as const,
  ...overrides,
})

const registrant = (mentraUserId = OTHER_ADMIN) => ({mentraUserId, tenantId: "mentra"})
const rule = (kind: RegistryArchiveRule["kind"], value: string) => ({kind, value})
const by = {reason: "test", createdBy: "admin@example.com"}

interface SignOptions {
  service?: string
  secret?: string
  /** Sign this body instead of the one sent. */
  signedBody?: string
  rawBody?: string
  unsigned?: boolean
}

/** A signed request to the registry's service API, as Fleet or the Store sends it. */
async function signed(method: "GET" | "POST", pathWithQuery: string, body: unknown, options: SignOptions = {}) {
  const path = `/api/internal/registry${pathWithQuery}`
  const text = method === "GET" ? "" : (options.rawBody ?? JSON.stringify(body))
  const timestampMs = Date.now()
  const service =
    options.service ?? (pathWithQuery.startsWith("/check") || pathWithQuery.startsWith("/lookup") ? "fleet" : "store")
  const headers: Record<string, string> = {"content-type": "application/json"}
  if (!options.unsigned) {
    headers[SERVICE_HEADERS.service] = service
    headers[SERVICE_HEADERS.timestamp] = String(timestampMs)
    headers[SERVICE_HEADERS.signature] = signServiceRequest({
      secret: options.secret ?? (service === "fleet" ? "fleet-f1" : "store-s1"),
      method,
      pathWithQuery: path,
      body: options.signedBody ?? text,
      timestampMs,
    })
  }
  const response = await app.request(`${BASE}${path}`, {method, headers, body: method === "GET" ? undefined : text})
  const answer = await response.text()
  let json: any = null
  try {
    json = answer ? JSON.parse(answer) : null
  } catch {
    // A non-JSON body shows up as a failed assertion on `json`.
  }
  return {status: response.status, json}
}

async function check(urls: string[], options: {workspaceId?: string; mentraUserId?: string} = {}) {
  const answer = await signed("POST", "/check", {
    urls,
    workspaceId: options.workspaceId ?? "ws_acme",
    mentraUserId: options.mentraUserId ?? ADMIN,
  })
  expect(answer.status).toBe(200)
  return answer.json.results as Array<Record<string, unknown>>
}

async function lookup(packageNames: string[], workspaceId = "ws_acme") {
  const answer = await signed("POST", "/lookup", {workspaceId, packageNames})
  expect(answer.status).toBe(200)
  return answer.json.entries as Record<string, Record<string, unknown> | null>
}

async function entryFor(url: string) {
  return signed("GET", `/entries?${new URLSearchParams({url}).toString()}`, undefined)
}

const entryRow = (url: string) => MiniappRegistryEntryModel.findOne({url}).lean()

/** A check result without its time, which each test checks once. */
const withoutTime = ({checkedAt, ...rest}: Record<string, unknown>) => {
  expect(Number.isNaN(Date.parse(String(checkedAt)))).toBe(false)
  return rest
}

// --- Check -------------------------------------------------------------------

describe("check", () => {
  test("registers an unknown URL as the admin, and answers accepted with its name", async () => {
    serve(NOTES_URL, manifest())
    const [result] = await check([NOTES_URL])
    expect(withoutTime(result!)).toEqual({
      url: NOTES_URL,
      status: "accepted",
      packageName: NOTES,
      name: "Notes",
      iconUrl: `${NOTES_URL}icon.png`,
      private: false,
    })
    expect(fetches).toEqual([{url: NOTES_URL, claims: null}])
    const row = await entryRow(NOTES_URL)
    expect({by: row?.firstRegisteredBy, verification: row?.verification, name: row?.name}).toEqual({
      by: ADMIN,
      verification: "verified",
      name: "Notes",
    })
  })

  test("answers a URL the registry holds from its entry, without reading it", async () => {
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    // A phone installed an intranet miniapp Core can't reach.
    await registerMiniappUrl({url: INTRANET_URL, reported: reported(), registrant: registrant()})
    fetches = []

    const results = await check([NOTES_URL, INTRANET_URL])
    expect(results.map(withoutTime)).toEqual([
      {
        url: NOTES_URL,
        status: "accepted",
        packageName: NOTES,
        name: "Notes",
        iconUrl: `${NOTES_URL}icon.png`,
        private: false,
      },
      {
        url: INTRANET_URL,
        status: "accepted_unverified",
        packageName: "com.globex.inventory",
        name: "Inventory",
        iconUrl: null,
        private: false,
      },
    ])
    expect(fetches).toEqual([])
  })

  test("a private miniapp's challenge gets a token for the admin that names the assigning workspace", async () => {
    // The workspace hasn't assigned the package yet: it is assigning it now.
    servePrivate(ACME_URL, ACME_TOOLS, acmeManifest(), (claims) => claims.workspaceId === "ws_acme")
    const [result] = await check([ACME_URL])
    expect(withoutTime(result!)).toEqual({
      url: ACME_URL,
      status: "accepted",
      packageName: ACME_TOOLS,
      name: "Acme Tools",
      iconUrl: `${ACME_URL}icon.png`,
      private: true,
    })
    expect(
      fetches.map(
        (fetch) =>
          fetch.claims && {aud: fetch.claims.aud, sub: fetch.claims.sub, workspaceId: fetch.claims.workspaceId},
      ),
    ).toEqual([null, {aud: ACME_TOOLS, sub: ADMIN, workspaceId: "ws_acme"}])
    expect((await entryRow(ACME_URL))?.private).toBe(true)
  })

  test("a private server that refuses the workspace is accepted_unverified, with only its package", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, acmeManifest(), () => false)
    const [result] = await check([ACME_URL])
    expect(withoutTime(result!)).toEqual({
      url: ACME_URL,
      status: "accepted_unverified",
      packageName: ACME_TOOLS,
      name: null,
      iconUrl: null,
      private: true,
    })
    const row = await entryRow(ACME_URL)
    expect({
      verification: row?.verification,
      private: row?.private,
      name: row?.name,
      by: row?.firstRegisteredBy,
    }).toEqual({
      verification: "phone_reported",
      private: true,
      name: null,
      by: ADMIN,
    })
  })

  test("a private entry is read again for each check, and named only to a workspace its server admits", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, acmeManifest(), (claims) => claims.workspaceId === "ws_acme")
    expect((await check([ACME_URL]))[0]?.name).toBe("Acme Tools")

    fetches = []
    const [refused] = await check([ACME_URL], {workspaceId: "ws_globex", mentraUserId: OTHER_ADMIN})
    expect(withoutTime(refused!)).toEqual({
      url: ACME_URL,
      status: "accepted_unverified",
      packageName: ACME_TOOLS,
      name: null,
      iconUrl: null,
      private: true,
    })
    expect(fetches.map((fetch) => fetch.claims?.workspaceId ?? null)).toEqual([null, "ws_globex"])
    // What Core verified for the first workspace is kept.
    expect((await entryRow(ACME_URL))?.name).toBe("Acme Tools")
  })

  test("not a miniapp: an invalid manifest or a package its domain doesn't own, and URLs that can't be one, unread", async () => {
    serve("https://broken.example.com/", manifest({packageName: "com.example.broken", version: "one"}))
    serve("https://other.example.com/", manifest({packageName: "com.acme.notes"}))
    const urls = [
      "https://broken.example.com/",
      "https://other.example.com/",
      "http://notes.example.com/",
      "https://192.168.1.10/",
      "https://8.8.8.8/",
      "not a url",
    ]
    const results = await check(urls)
    expect(results.map((result) => [result.url, result.status, result.packageName])).toEqual(
      urls.map((url) => [url, "not_a_miniapp", null]),
    )
    // Read side by side, so in either order.
    expect(fetches.map((fetch) => fetch.url).sort()).toEqual([
      "https://broken.example.com/",
      "https://other.example.com/",
    ])
    expect(await MiniappRegistryEntryModel.countDocuments()).toBe(0)
  })

  test("a URL Core can't reach and no phone has reported is unreachable, and can be assigned once a phone reports it", async () => {
    const [unreachable] = await check([INTRANET_URL])
    expect(withoutTime(unreachable!)).toEqual({
      url: INTRANET_URL,
      status: "unreachable",
      packageName: null,
      name: null,
      iconUrl: null,
      private: false,
    })
    expect(await entryRow(INTRANET_URL)).toBeNull()

    await registerMiniappUrl({url: INTRANET_URL, reported: reported(), registrant: registrant()})
    expect((await check([INTRANET_URL]))[0]?.status).toBe("accepted_unverified")
  })

  test("archived: a rule covering an unknown URL refuses it unread, and an archived entry answers with its package", async () => {
    await archive(rule("domain", "acme.com"), by)
    serve("https://new.acme.com/", acmeManifest())
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    await archive(rule("package", NOTES), by)
    fetches = []

    const results = await check(["https://new.acme.com/", NOTES_URL])
    expect(results.map((result) => [result.status, result.packageName, result.name])).toEqual([
      ["archived", null, null],
      ["archived", NOTES, "Notes"],
    ])
    expect(fetches).toEqual([])
    expect(await entryRow("https://new.acme.com/")).toBeNull()

    // A rule for the admin's account covers the URLs they would register.
    await archive(rule("account", OTHER_ADMIN), by)
    serve("https://fresh.example.com/", manifest({packageName: "com.example.fresh"}))
    const [mine] = await check(["https://fresh.example.com/"], {workspaceId: "ws_globex", mentraUserId: OTHER_ADMIN})
    expect(mine?.status).toBe("archived")
    expect(fetches).toEqual([])
  })

  test("answers every URL in order, with each URL as sent, reading each distinct URL once", async () => {
    serve(NOTES_URL, manifest())
    const urls = [NOTES_URL, "https://notes.example.com", "https://Notes.Example.com/", NOTES_URL]
    const results = await check(urls)
    expect(results.map((result) => [result.url, result.status])).toEqual(urls.map((url) => [url, "accepted"]))
    expect(fetches).toHaveLength(1)
  })

  test("the person must be an active member of the active workspace", async () => {
    serve(NOTES_URL, manifest())
    await WorkspaceModel.create({workspaceId: "ws_gone", name: "Gone", status: "deleted"})
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_gone",
        workspaceId: "ws_gone",
        mentraUserId: ADMIN,
        role: "owner",
        status: "active",
        startedAt: new Date(),
      }),
    )
    await WorkspaceMembershipModel.updateOne({workspaceId: "ws_globex"}, {$set: {status: "ended", endedAt: new Date()}})

    for (const [workspaceId, mentraUserId] of [
      ["ws_globex", ADMIN], // not a member
      ["ws_globex", OTHER_ADMIN], // left
      ["ws_gone", ADMIN], // deleted workspace
      ["ws_nowhere", ADMIN], // no such workspace
      ["ws_acme", "mu_stranger"], // no such person
    ] as const) {
      const answer = await signed("POST", "/check", {urls: [NOTES_URL], workspaceId, mentraUserId})
      expect({workspaceId, mentraUserId, status: answer.status, error: answer.json?.error}).toEqual({
        workspaceId,
        mentraUserId,
        status: 403,
        error: "not_a_member",
      })
    }

    // A deleted account is a member of nothing.
    await UserModel.updateOne({mentraUserId: ADMIN}, {$set: {supportTelemetryDeletedAt: new Date()}})
    expect(
      (await signed("POST", "/check", {urls: [NOTES_URL], workspaceId: "ws_acme", mentraUserId: ADMIN})).status,
    ).toBe(403)
    expect(fetches).toEqual([])
  })

  test("counts reads against the admin's hourly registrations, shared with their phones", async () => {
    setSystemTime(new Date("2026-10-24T12:30:00.000Z"))
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    const windowStart = Date.parse("2026-10-24T12:00:00.000Z")
    await AuthRateLimitModel.updateOne({_id: `miniapp-registry:${ADMIN}:${windowStart}`}, {$set: {count: 119}})
    serve("https://one.example.com/", manifest({packageName: "com.example.one"}))
    serve("https://two.example.com/", manifest({packageName: "com.example.two"}))
    fetches = []

    const results = await check(["https://one.example.com/", "https://two.example.com/", NOTES_URL])
    // One more read fits this hour; the other URL is asked about again later. A held entry needs no read.
    expect(results.map((result) => result.status).sort()).toEqual(["accepted", "accepted", "unknown"])
    expect(results[2]?.status).toBe("accepted")
    expect(fetches).toHaveLength(1)
  })

  test("reads at most 8 URLs at once, and answers within 10 seconds with the URLs it didn't finish unknown", async () => {
    const urls = Array.from({length: 50}, (_, index) => `https://app${index}.example.com/`)
    let inFlight = 0
    let mostInFlight = 0
    for (const [index, url] of urls.entries()) {
      served.set(
        url,
        () =>
          new Promise<MiniappFetchResult>((resolve) => {
            inFlight++
            mostInFlight = Math.max(mostInFlight, inFlight)
            held.push(() => {
              inFlight--
              resolve(
                ok(manifest({packageName: `com.example.app${index}`, name: `App ${index}`}), `${url}miniapp.json`),
              )
            })
          }),
      )
    }

    const started = Date.now()
    const answer = check(urls)
    const waitFor = async (count: number) => {
      while (fetches.length < count) await Bun.sleep(10)
    }
    // Two rounds of 8 finish; the third round is still being read at the deadline.
    for (const round of [1, 2, 3]) {
      await waitFor(round * 8)
      await Bun.sleep(50)
      expect(fetches).toHaveLength(round * 8)
      expect(inFlight).toBe(8)
      if (round < 3) for (const release of held.splice(0)) release()
    }
    const results = await answer
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(9_500)
    expect(elapsed).toBeLessThan(13_000)
    expect(mostInFlight).toBe(8)
    expect(results.map((result) => result.url)).toEqual(urls)
    expect(results.slice(0, 16).every((result) => result.status === "accepted")).toBe(true)
    expect(results.slice(16).every((result) => result.status === "unknown" && result.packageName === null)).toBe(true)
    // No URL is started after the deadline; the ones being read finish in the background.
    await Bun.sleep(100)
    expect(fetches).toHaveLength(24)
    for (const release of held.splice(0)) release()
    await registryChecksIdle()
    expect(await MiniappRegistryEntryModel.countDocuments()).toBe(24)
  })

  test("refuses a body that isn't what the route takes", async () => {
    const valid = {urls: [NOTES_URL], workspaceId: "ws_acme", mentraUserId: ADMIN}
    for (const body of [
      {...valid, urls: []},
      {...valid, urls: Array.from({length: 51}, (_, index) => `https://app${index}.example.com/`)},
      {...valid, urls: [7]},
      {urls: [NOTES_URL], mentraUserId: ADMIN},
      {urls: [NOTES_URL], workspaceId: "ws_acme"},
      {...valid, mentraUserId: ""},
    ]) {
      const answer = await signed("POST", "/check", body)
      expect({status: answer.status, error: answer.json?.error}).toEqual({status: 400, error: "invalid_request"})
    }
    expect((await signed("POST", "/check", null, {rawBody: "not json"})).status).toBe(400)
    expect(fetches).toEqual([])
  })
})

// --- Lookup ------------------------------------------------------------------

describe("lookup", () => {
  test("names each package from its most recently verified active entry, and null for one the registry hasn't seen", async () => {
    setSystemTime(new Date("2026-10-24T08:00:00.000Z"))
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    setSystemTime(new Date("2026-10-24T09:00:00.000Z"))
    serve(`${NOTES_URL}v2/`, manifest({name: "Notes 2", icon: "https://cdn.example.com/notes2.png"}))
    await check([`${NOTES_URL}v2/`])

    expect(await lookup([NOTES, "com.example.unknown"])).toEqual({
      [NOTES]: {name: "Notes 2", iconUrl: "https://cdn.example.com/notes2.png", private: false, archived: false},
      "com.example.unknown": null,
    })

    // The newer URL archived: the package is named from the one still active.
    await archive(rule("url", `${NOTES_URL}v2/`), by)
    expect((await lookup([NOTES]))[NOTES]).toEqual({
      name: "Notes",
      iconUrl: `${NOTES_URL}icon.png`,
      private: false,
      archived: false,
    })

    // Every URL archived: the most recent one, marked archived.
    await archive(rule("package", NOTES), by)
    expect((await lookup([NOTES]))[NOTES]).toEqual({
      name: "Notes 2",
      iconUrl: "https://cdn.example.com/notes2.png",
      private: false,
      archived: true,
    })
  })

  test("a verified entry comes before a phone-reported one, which names a package when none is verified", async () => {
    await registerMiniappUrl({url: INTRANET_URL, reported: reported(), registrant: registrant()})
    expect(await lookup(["com.globex.inventory"])).toEqual({
      "com.globex.inventory": {name: "Inventory", iconUrl: null, private: false, archived: false},
    })

    serve(
      "https://apps.globex.com/inventory/",
      manifest({packageName: "com.globex.inventory", name: "Inventory (verified)"}),
    )
    await check(["https://apps.globex.com/inventory/"])
    expect((await lookup(["com.globex.inventory"]))["com.globex.inventory"]?.name).toBe("Inventory (verified)")
  })

  test("names a private miniapp only for a workspace that assigned it", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, acmeManifest(), (claims) => claims.workspaceId === "ws_acme")
    await check([ACME_URL])
    const unnamed = {name: null, iconUrl: null, private: true, archived: false}

    // Not assigned yet, and never by the other workspace.
    expect((await lookup([ACME_TOOLS], "ws_acme"))[ACME_TOOLS]).toEqual(unnamed)
    await WorkspaceAssignedPackagesModel.create({workspaceId: "ws_acme", packageNames: [ACME_TOOLS], revision: 1})
    await WorkspaceAssignedPackagesModel.create({workspaceId: "ws_globex", packageNames: [NOTES], revision: 1})
    expect((await lookup([ACME_TOOLS], "ws_acme"))[ACME_TOOLS]).toEqual({
      name: "Acme Tools",
      iconUrl: `${ACME_URL}icon.png`,
      private: true,
      archived: false,
    })
    expect((await lookup([ACME_TOOLS], "ws_globex"))[ACME_TOOLS]).toEqual(unnamed)
  })

  test("an archive rule decides, even when the entry's status wasn't set", async () => {
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    await MiniappRegistryArchiveRuleModel.create({
      kind: "domain",
      value: "example.com",
      reason: "",
      createdBy: "x",
      createdAt: new Date(),
    })
    expect((await entryRow(NOTES_URL))?.status).toBe("active")
    expect((await lookup([NOTES]))[NOTES]?.archived).toBe(true)
  })

  test("answers every name asked about, and refuses a body that isn't what the route takes", async () => {
    expect(await lookup(["Not A Package", "__proto__", NOTES])).toEqual({
      "Not A Package": null,
      ["__proto__"]: null,
      [NOTES]: null,
    })
    for (const body of [
      {workspaceId: "ws_acme", packageNames: []},
      {workspaceId: "ws_acme", packageNames: Array.from({length: 501}, (_, index) => `com.example.app${index}`)},
      {workspaceId: "ws_acme", packageNames: [7]},
      {packageNames: [NOTES]},
    ]) {
      const answer = await signed("POST", "/lookup", body)
      expect({status: answer.status, error: answer.json?.error}).toEqual({status: 400, error: "invalid_request"})
    }
  })
})

// --- The directory -----------------------------------------------------------

describe("entries", () => {
  test("answers a verified entry with Core's verified miniapp.json, for the URL in any spelling", async () => {
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    const answer = await entryFor("https://Notes.Example.com")
    expect(answer.status).toBe(200)
    const {firstRegisteredAt, lastVerifiedAt, manifest: copy, ...view} = answer.json.entry
    expect(view).toEqual({
      url: NOTES_URL,
      packageName: NOTES,
      registrableDomain: "example.com",
      name: "Notes",
      version: "1.0.0",
      ageRating: "4+",
      iconUrl: `${NOTES_URL}icon.png`,
      verification: "verified",
      private: false,
      status: "active",
    })
    expect(Number.isNaN(Date.parse(firstRegisteredAt))).toBe(false)
    expect(Number.isNaN(Date.parse(lastVerifiedAt))).toBe(false)
    // Core's copy as served, with fields the schema doesn't name and the SHA-256 lowercased.
    expect(copy).toEqual({...manifest(), bundle: {url: `${NOTES}-1.0.0.zip`, sha256: SHA.toLowerCase()}})
  })

  test("is 404 for a URL the registry doesn't hold, and 400 without one", async () => {
    for (const url of [NOTES_URL, "http://192.168.1.10/", "not a url"]) {
      const answer = await entryFor(url)
      expect({url, status: answer.status, error: answer.json?.error}).toEqual({url, status: 404, error: "not_found"})
    }
    expect((await signed("GET", "/entries", undefined)).status).toBe(400)
  })

  test("a private or phone-reported entry comes with its URL and package only", async () => {
    servePrivate(ACME_URL, ACME_TOOLS, acmeManifest(), () => true)
    await check([ACME_URL])
    await registerMiniappUrl({url: INTRANET_URL, reported: reported(), registrant: registrant()})

    const privateEntry = (await entryFor(ACME_URL)).json.entry
    expect({...privateEntry, firstRegisteredAt: null, lastVerifiedAt: null}).toEqual({
      url: ACME_URL,
      packageName: ACME_TOOLS,
      registrableDomain: "acme.com",
      name: null,
      version: null,
      ageRating: null,
      iconUrl: null,
      verification: "verified",
      private: true,
      status: "active",
      firstRegisteredAt: null,
      lastVerifiedAt: null,
      manifest: null,
    })
    const reportedEntry = (await entryFor(INTRANET_URL)).json.entry
    expect([reportedEntry.verification, reportedEntry.name, reportedEntry.version, reportedEntry.manifest]).toEqual([
      "phone_reported",
      null,
      null,
      null,
    ])
  })

  test("reports an entry an archive rule covers as archived", async () => {
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    await MiniappRegistryArchiveRuleModel.create({
      kind: "account",
      value: ADMIN,
      reason: "",
      createdBy: "x",
      createdAt: new Date(),
    })
    expect((await entryFor(NOTES_URL)).json.entry.status).toBe("archived")
  })
})

describe("archive", () => {
  test("archives for a staff member, recorded in Core's admin audit log with the Store as the service", async () => {
    serve(NOTES_URL, manifest())
    await check([NOTES_URL])
    const body = {
      rule: {kind: "url", value: "https://notes.example.com"},
      reason: "Reported: spam",
      actorEmail: "staff@example.com",
    }

    const answer = await signed("POST", "/archive", body)
    expect({status: answer.status, json: answer.json}).toEqual({
      status: 200,
      json: {rule: {kind: "url", value: NOTES_URL}, created: true, entriesArchived: 1},
    })
    expect(
      await MiniappRegistryArchiveRuleModel.findOne({kind: "url"})
        .select({_id: 0, kind: 1, value: 1, reason: 1, createdBy: 1})
        .lean(),
    ).toEqual({
      kind: "url",
      value: NOTES_URL,
      reason: "Reported: spam",
      createdBy: "store:staff@example.com",
    })
    // Beside the admin portal's own archives, in the admin action audit log.
    const logged = () =>
      AdminActionAuditLogModel.find({action: "miniapp_registry.archive"})
        .sort({createdAt: 1})
        .select({_id: 0, adminId: 1, targetType: 1, targetId: 1, reason: 1, metadata: 1})
        .lean()
    const entry = (created: boolean, entriesArchived: number) => ({
      adminId: "store:staff@example.com",
      targetType: "miniapp_registry_rule",
      targetId: `url:${NOTES_URL}`,
      reason: "Reported: spam",
      metadata: {service: "store", actorEmail: "staff@example.com", created, entriesArchived},
    })
    expect(await logged()).toEqual([entry(true, 1)])
    expect((await check([NOTES_URL]))[0]?.status).toBe("archived")

    // Again: nothing changes, and the call is recorded as the admin portal records a repeat.
    const again = await signed("POST", "/archive", body)
    expect(again.json).toEqual({rule: {kind: "url", value: NOTES_URL}, created: false, entriesArchived: 0})
    expect(await logged()).toEqual([entry(true, 1), entry(false, 0)])
  })

  test("refuses a rule that can't name an entry, and a body that isn't what the route takes", async () => {
    const valid = {rule: {kind: "domain", value: "example.com"}, reason: "", actorEmail: "staff@example.com"}
    for (const body of [
      {...valid, rule: {kind: "domain", value: "notes.example.com"}},
      {...valid, rule: {kind: "url", value: "http://notes.example.com/"}},
      {...valid, rule: {kind: "package", value: "Not A Package"}},
      {...valid, rule: {kind: "everything", value: "x"}},
      {...valid, actorEmail: "staff"},
      {rule: valid.rule, reason: ""},
      {rule: valid.rule, actorEmail: "staff@example.com"},
    ]) {
      const answer = await signed("POST", "/archive", body)
      expect({body, status: answer.status, error: answer.json?.error}).toEqual({
        body,
        status: 400,
        error: "invalid_request",
      })
    }
    expect(await MiniappRegistryArchiveRuleModel.countDocuments()).toBe(0)
  })
})

// --- Who may call ------------------------------------------------------------

describe("who may call", () => {
  const routes = [
    {
      method: "POST" as const,
      path: "/check",
      body: {urls: [NOTES_URL], workspaceId: "ws_acme", mentraUserId: ADMIN},
      owner: "fleet",
    },
    {method: "POST" as const, path: "/lookup", body: {workspaceId: "ws_acme", packageNames: [NOTES]}, owner: "fleet"},
    {method: "GET" as const, path: `/entries?url=${encodeURIComponent(NOTES_URL)}`, body: undefined, owner: "store"},
    {
      method: "POST" as const,
      path: "/archive",
      body: {rule: {kind: "url", value: NOTES_URL}, reason: "", actorEmail: "a@example.com"},
      owner: "store",
    },
  ]

  test("each route is one service's, and the other is 403", async () => {
    for (const route of routes) {
      const other = route.owner === "fleet" ? "store" : "fleet"
      const answer = await signed(route.method, route.path, route.body, {service: other})
      expect({path: route.path, status: answer.status, error: answer.json?.error}).toEqual({
        path: route.path,
        status: 403,
        error: "forbidden",
      })
    }
    expect(fetches).toEqual([])
    expect(await MiniappRegistryArchiveRuleModel.countDocuments()).toBe(0)
  })

  test("an unsigned call, a wrong secret or a tampered body is 401", async () => {
    for (const route of routes) {
      const attempts: SignOptions[] = [{unsigned: true}, {secret: "wrong"}]
      if (route.body) attempts.push({signedBody: JSON.stringify({...route.body, tampered: true})})
      for (const options of attempts) {
        const answer = await signed(route.method, route.path, route.body, options)
        expect({path: route.path, status: answer.status, error: answer.json?.error}).toEqual({
          path: route.path,
          status: 401,
          error: "service_unauthorized",
        })
      }
    }
    expect(fetches).toEqual([])
  })

  test("a body over 64 KiB is 413", async () => {
    const urls = Array.from({length: 40}, (_, index) => `https://app${index}.example.com/${"a".repeat(1800)}/`)
    const answer = await signed("POST", "/check", {urls, workspaceId: "ws_acme", mentraUserId: ADMIN})
    expect({status: answer.status, error: answer.json?.error}).toEqual({status: 413, error: "payload_too_large"})
  })
})

// --- The contract's client ---------------------------------------------------

describe("the workspace contract's client", () => {
  const clientAs = (service: "fleet" | "store") =>
    createCoreWorkspaceClient({
      baseUrl: BASE,
      service,
      secret: service === "fleet" ? "fleet-f1" : "store-s1",
      fetch: ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
    })

  test("speaks every route", async () => {
    serve(NOTES_URL, manifest())
    const fleet = clientAs("fleet")
    const store = clientAs("store")

    const [result] = await fleet.checkRegistry({urls: [NOTES_URL], workspaceId: "ws_acme", mentraUserId: ADMIN})
    expect(result?.status).toBe("accepted")
    expect(await fleet.lookupRegistry({workspaceId: "ws_acme", packageNames: [NOTES, "com.example.none"]})).toEqual({
      [NOTES]: {name: "Notes", iconUrl: `${NOTES_URL}icon.png`, private: false, archived: false},
      "com.example.none": null,
    })
    expect((await store.getRegistryEntry(NOTES_URL))?.manifest?.name).toBe("Notes")
    expect(await store.getRegistryEntry("https://none.example.com/")).toBeNull()
    expect(
      await store.archiveRegistry({rule: {kind: "package", value: NOTES}, reason: "", actorEmail: "staff@example.com"}),
    ).toEqual({
      rule: {kind: "package", value: NOTES},
      created: true,
      entriesArchived: 1,
    })
    expect((await store.getRegistryEntry(NOTES_URL))?.status).toBe("archived")

    await expect(
      fleet.checkRegistry({urls: [NOTES_URL], workspaceId: "ws_globex", mentraUserId: ADMIN}),
    ).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    })
    await expect(store.lookupRegistry({workspaceId: "ws_acme", packageNames: [NOTES]})).rejects.toMatchObject({
      code: "forbidden",
    })
  })
})
