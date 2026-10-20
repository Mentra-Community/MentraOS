/**
 * @fileoverview The `features` claim: licensed features in a person's miniapp token.
 *
 * `featuresFor` and `POST /api/client/auth/miniapp-token` run against real `licenses` and `license_seats`
 * rows on a local replica set. A person holds a feature through a license of their own or a seat in a
 * workspace's license, while that license is in its term (`validFrom <= now < paidThrough`, not ended), and
 * only for the packages the feature lists. `CLOUD_CORE_ENABLED_FEATURES` grants an entry's feature to every
 * signed-in person in the listed packages' tokens.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The
 * database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/license-features.integration.test.ts`
 */

import crypto from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import * as jose from "jose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import * as trustedEmail from "../packages/core/src/services/account/trusted-email.service"
import {featuresFor} from "../packages/core/src/services/licenses/features.service"
import * as session from "../packages/core/src/services/session.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {applyEnv} from "./support/signin-harness"

const MODELS = [LicenseModel, LicenseSeatModel]

const CALL = "com.mentra.call"
const NOTES = "com.mentra.notes"
const UNLIMITED = "call.unlimited"
const NOW = new Date("2026-10-20T12:00:00.000Z")

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let restoreEnv: () => void = () => {}
const mocks: Array<{mockRestore(): void}> = []

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("license-features")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would
  // silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, LicenseModel.db.name)
  verified = true
  // Startup migrations do not run here; the lookups should meet the indexes they run on.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && LicenseModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, LicenseModel.db.name)
    await LicenseModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({CLOUD_CORE_ENABLED_FEATURES: undefined})
  assertConnectedTo(databaseUrl, LicenseModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
})

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
  restoreEnv()
})

// --- Fixtures --------------------------------------------------------------

let counter = 0

/** A license id as billing writes one: 26 characters. */
const newLicenseId = () => `01LICENSE${String(counter++).padStart(17, "0")}`

const inMs = (ms: number) => new Date(NOW.getTime() + ms)
const DAY = 24 * 60 * 60 * 1000

interface LicenseFields {
  features?: Array<{key: string; packages: string[]}>
  validFrom?: Date
  paidThrough?: Date
  endedAt?: Date | null
}

/** A license in its term at `NOW`, for Call unless the fields say otherwise. */
async function insertLicense(owner: Record<string, string>, fields: LicenseFields = {}): Promise<string> {
  const _id = newLicenseId()
  await LicenseModel.create({
    _id,
    owner,
    product: "mentra.call.unlimited",
    features: fields.features ?? [{key: UNLIMITED, packages: [CALL]}],
    quantity: owner.type === "person" ? 1 : 5,
    seatsUsed: owner.type === "person" ? 1 : 0,
    validFrom: fields.validFrom ?? inMs(-10 * DAY),
    paidThrough: fields.paidThrough ?? inMs(20 * DAY),
    revision: 1,
    endedAt: fields.endedAt ?? null,
    endedReason: fields.endedAt ? "workspace_deleted" : null,
  })
  return _id
}

const personal = (mentraUserId: string, fields?: LicenseFields) => insertLicense({type: "person", mentraUserId}, fields)

/** A workspace's license, with a seat for each of `holders`. */
async function workspaceLicense(workspaceId: string, holders: string[], fields?: LicenseFields): Promise<string> {
  const licenseId = await insertLicense({type: "workspace", workspaceId}, fields)
  for (const mentraUserId of holders) {
    await LicenseSeatModel.create({
      licenseId,
      workspaceId,
      membershipId: `wm_${counter++}`,
      mentraUserId,
      assignedAt: NOW,
      assignedBy: null,
    })
  }
  await LicenseModel.updateOne({_id: licenseId}, {$set: {seatsUsed: holders.length}})
  return licenseId
}

const lookup = (mentraUserId: string, packageName = CALL, now = NOW) => featuresFor({mentraUserId, packageName, now})

// --- Licenses and seats ----------------------------------------------------

describe("who holds a feature", () => {
  test("a person with nothing has no feature", async () => {
    expect(await lookup("mu_nobody")).toEqual([])
  })

  test("a personal license gives its feature", async () => {
    await personal("mu_alice")
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])
  })

  test("a seat in a workspace license gives its feature", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"])
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])
  })

  test("a personal license and a seat in the same feature give it once", async () => {
    await personal("mu_alice")
    await workspaceLicense("ws_acme", ["mu_alice"])
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])
  })

  test("with either one ended, the other still gives the feature", async () => {
    const ended = {endedAt: inMs(-DAY)}

    await personal("mu_alice", ended)
    await workspaceLicense("ws_acme", ["mu_alice"])
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])

    await personal("mu_bob")
    await workspaceLicense("ws_acme", ["mu_bob"], ended)
    expect(await lookup("mu_bob")).toEqual([UNLIMITED])

    await personal("mu_carol", ended)
    await workspaceLicense("ws_acme", ["mu_carol"], ended)
    expect(await lookup("mu_carol")).toEqual([])
  })

  test("a workspace license gives nothing to a person without a seat, or to another person's seat", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"])
    expect(await lookup("mu_bob")).toEqual([])
  })

  test("a personal license is its owner's alone", async () => {
    await personal("mu_alice")
    expect(await lookup("mu_bob")).toEqual([])
  })

  test("a released seat gives nothing", async () => {
    const licenseId = await workspaceLicense("ws_acme", ["mu_alice"])
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])

    await LicenseSeatModel.deleteMany({licenseId})
    expect(await lookup("mu_alice")).toEqual([])
  })

  test("seats in several workspaces, and licenses of several products, are all counted, sorted and unique", async () => {
    await personal("mu_alice", {features: [{key: "call.transcripts", packages: [CALL]}]})
    await personal("mu_alice", {
      features: [
        {key: UNLIMITED, packages: [CALL]},
        {key: "call.recording", packages: [CALL, NOTES]},
      ],
    })
    await workspaceLicense("ws_acme", ["mu_alice"], {features: [{key: UNLIMITED, packages: [CALL]}]})
    await workspaceLicense("ws_globex", ["mu_alice"], {features: [{key: "call.analytics", packages: [CALL]}]})
    expect(await lookup("mu_alice")).toEqual(["call.analytics", "call.recording", "call.transcripts", UNLIMITED])
  })
})

describe("a license's term", () => {
  test("is valid from validFrom, inclusive, to paidThrough, exclusive", async () => {
    await personal("mu_from", {validFrom: NOW, paidThrough: inMs(DAY)})
    expect(await lookup("mu_from")).toEqual([UNLIMITED])

    await personal("mu_until", {validFrom: inMs(-DAY), paidThrough: inMs(1)})
    expect(await lookup("mu_until")).toEqual([UNLIMITED])

    await personal("mu_expired_now", {validFrom: inMs(-DAY), paidThrough: NOW})
    expect(await lookup("mu_expired_now")).toEqual([])
  })

  test("an expired license gives nothing", async () => {
    await personal("mu_alice", {validFrom: inMs(-40 * DAY), paidThrough: inMs(-10 * DAY)})
    await workspaceLicense("ws_acme", ["mu_alice"], {validFrom: inMs(-40 * DAY), paidThrough: inMs(-1)})
    expect(await lookup("mu_alice")).toEqual([])
  })

  test("a license that has not started gives nothing", async () => {
    await personal("mu_alice", {validFrom: inMs(1), paidThrough: inMs(30 * DAY)})
    await workspaceLicense("ws_acme", ["mu_alice"], {validFrom: inMs(DAY), paidThrough: inMs(30 * DAY)})
    expect(await lookup("mu_alice")).toEqual([])
  })

  test("an ended license gives nothing, though its dates still cover now", async () => {
    await personal("mu_alice", {endedAt: inMs(-1)})
    await workspaceLicense("ws_acme", ["mu_alice"], {endedAt: inMs(-DAY)})
    expect(await lookup("mu_alice")).toEqual([])
  })

  test("is judged at the time asked about, not the time of the call", async () => {
    await personal("mu_alice", {validFrom: inMs(-DAY), paidThrough: inMs(DAY)})
    expect(await lookup("mu_alice", CALL, inMs(0))).toEqual([UNLIMITED])
    expect(await lookup("mu_alice", CALL, inMs(2 * DAY))).toEqual([])
    expect(await lookup("mu_alice", CALL, inMs(-2 * DAY))).toEqual([])
  })

  test("a seat in an ended license is not read as a seat in a live one", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"], {endedAt: inMs(-DAY)})
    await workspaceLicense("ws_globex", ["mu_alice"], {features: [{key: "call.analytics", packages: [CALL]}]})
    expect(await lookup("mu_alice")).toEqual(["call.analytics"])
  })
})

describe("a feature's packages", () => {
  test("a seat in a license for another package never reaches this package's token", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"], {features: [{key: "notes.pro", packages: [NOTES]}]})
    expect(await lookup("mu_alice", CALL)).toEqual([])
    expect(await lookup("mu_alice", NOTES)).toEqual(["notes.pro"])
  })

  test("a personal license for another package never reaches this package's token", async () => {
    await personal("mu_alice", {features: [{key: "notes.pro", packages: [NOTES]}]})
    expect(await lookup("mu_alice", CALL)).toEqual([])
  })

  test("one license's features are filtered one by one", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"], {
      features: [
        {key: UNLIMITED, packages: [CALL]},
        {key: "notes.pro", packages: [NOTES]},
        {key: "shared.pro", packages: [NOTES, CALL]},
      ],
    })
    expect(await lookup("mu_alice", CALL)).toEqual([UNLIMITED, "shared.pro"])
    expect(await lookup("mu_alice", NOTES)).toEqual(["notes.pro", "shared.pro"])
    expect(await lookup("mu_alice", "com.example.other")).toEqual([])
  })

  test("a feature for no package reaches no token", async () => {
    await personal("mu_alice", {features: [{key: "service.only", packages: []}]})
    await workspaceLicense("ws_acme", ["mu_alice"], {features: [{key: "seat.service.only", packages: []}]})
    for (const packageName of [CALL, NOTES, "", "com.example.other"]) {
      expect(await lookup("mu_alice", packageName)).toEqual([])
    }
  })
})

describe("CLOUD_CORE_ENABLED_FEATURES", () => {
  const grant = (value: string | undefined) => {
    restoreEnv()
    restoreEnv = applyEnv({CLOUD_CORE_ENABLED_FEATURES: value})
  }

  test("an entry with packages gives its feature to everyone, in those packages' tokens only", async () => {
    grant("call.unlimited:com.mentra.call")
    for (const mentraUserId of ["mu_alice", "mu_bob"]) {
      expect(await lookup(mentraUserId, CALL)).toEqual([UNLIMITED])
      expect(await lookup(mentraUserId, NOTES)).toEqual([])
    }
  })

  test("an entry with several packages reaches each of them", async () => {
    grant("call.unlimited:com.mentra.call+com.mentra.notes")
    expect(await lookup("mu_alice", CALL)).toEqual([UNLIMITED])
    expect(await lookup("mu_alice", NOTES)).toEqual([UNLIMITED])
    expect(await lookup("mu_alice", "com.example.other")).toEqual([])
  })

  test("an entry without packages, such as Fleet's, reaches no token", async () => {
    grant("fleet.managed, call.unlimited")
    expect(await lookup("mu_alice", CALL)).toEqual([])
  })

  test("is added to what licenses give, each feature once", async () => {
    grant("call.unlimited:com.mentra.call, call.beta:com.mentra.call")
    await personal("mu_alice")
    await workspaceLicense("ws_acme", ["mu_alice"], {features: [{key: "call.recording", packages: [CALL]}]})
    expect(await lookup("mu_alice")).toEqual(["call.beta", "call.recording", UNLIMITED])
    expect(await lookup("mu_bob")).toEqual(["call.beta", UNLIMITED])
  })

  test("a blank setting adds nothing", async () => {
    grant("   ")
    expect(await lookup("mu_alice")).toEqual([])
  })
})

// --- The indexes -----------------------------------------------------------

describe("the lookups use the collections' indexes", () => {
  /** Every index a plan scans, found anywhere in its stages. */
  function scannedIndexes(plan: any): string[] {
    if (!plan || typeof plan !== "object") return []
    const own = plan.stage === "IXSCAN" ? [plan.indexName as string] : []
    const children = [plan.queryPlanner, plan.winningPlan, plan.inputStage, ...(plan.inputStages ?? [])]
    return [...own, ...children.flatMap(scannedIndexes)]
  }

  test("personal licenses by owner, seats by person and seated licenses by id", async () => {
    // Other people's licenses and seats, enough that scanning the collections (or only the owner type
    // or the workspace) would read dozens of documents where the person's own indexes read one.
    const others = 40
    for (let n = 0; n < others; n++) await personal(`mu_other_${n}`)
    for (let n = 0; n < others; n++) await workspaceLicense(`ws_other_${n}`, [`mu_seat_other_${n}`])
    await personal("mu_alice")
    await workspaceLicense("ws_acme", ["mu_alice"])

    // Collect the filters featuresFor sends, then ask Mongo how it runs each.
    const licenseFilters: any[] = []
    const seatFilters: any[] = []
    const licenseFind = LicenseModel.find.bind(LicenseModel)
    const seatFind = LicenseSeatModel.find.bind(LicenseSeatModel)
    mocks.push(
      spyOn(LicenseModel, "find").mockImplementation(((filter: any, ...rest: any[]) => {
        licenseFilters.push(filter)
        return (licenseFind as any)(filter, ...rest)
      }) as never),
      spyOn(LicenseSeatModel, "find").mockImplementation(((filter: any, ...rest: any[]) => {
        seatFilters.push(filter)
        return (seatFind as any)(filter, ...rest)
      }) as never),
    )
    expect(await lookup("mu_alice")).toEqual([UNLIMITED])
    for (const mock of mocks.splice(0)) mock.mockRestore()

    expect(licenseFilters).toHaveLength(2)
    expect(seatFilters).toHaveLength(1)
    const plans = {
      personal: await LicenseModel.find(licenseFilters.find((filter) => "owner.type" in filter)).explain(
        "executionStats",
      ),
      seated: await LicenseModel.find(licenseFilters.find((filter) => "_id" in filter)).explain("executionStats"),
      seats: await LicenseSeatModel.find(seatFilters[0]).explain("executionStats"),
    }
    expect(scannedIndexes(plans.personal)).toContain("owner.type_1_owner.mentraUserId_1")
    expect(scannedIndexes(plans.seated)).toContain("_id_")
    expect(scannedIndexes(plans.seats)).toContain("mentraUserId_1")
    // Alice has one license of her own, one seat and one seated license; nothing else is read.
    for (const plan of Object.values(plans)) {
      expect((plan as any).executionStats.totalDocsExamined).toBe(1)
      expect((plan as any).executionStats.totalKeysExamined).toBe(1)
    }
  })
})

// --- The miniapp token -----------------------------------------------------

describe("POST /api/client/auth/miniapp-token", () => {
  const SIGNING_ENV = ["MENTRA_MINIAPP_JWT_PRIVATE_KEY", "MENTRA_MINIAPP_JWT_PUBLIC_KEY"] as const
  const savedSigning = Object.fromEntries(SIGNING_ENV.map((key) => [key, process.env[key]]))
  const strip = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")

  beforeEach(() => {
    const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
    process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = strip(privateKey.export({type: "pkcs8", format: "pem"}).toString())
    process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = strip(publicKey.export({type: "spki", format: "pem"}).toString())
    session.resetSigningKeyCache()
    mocks.push(
      spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null),
      spyOn(session, "verifyAccessToken").mockResolvedValue({
        mentraUserId: "mu_alice",
        tenantId: "mentra",
        sessionId: "sess",
        jti: "jti",
        exp: Math.floor(Date.now() / 1000) + 300,
      } as never),
    )
  })

  afterEach(() => {
    for (const key of SIGNING_ENV) {
      if (savedSigning[key] === undefined) delete process.env[key]
      else process.env[key] = savedSigning[key]
    }
    session.resetSigningKeyCache()
  })

  async function mint(packageName: string): Promise<jose.JWTPayload> {
    const response = await createApp({readinessChecks: []}).request("http://localhost/api/client/auth/miniapp-token", {
      method: "POST",
      headers: {"Authorization": "Bearer access", "Content-Type": "application/json"},
      body: JSON.stringify({packageName}),
    })
    expect(response.status).toBe(200)
    const {token} = (await response.json()) as {token: string}
    const pem = `-----BEGIN PUBLIC KEY-----\n${process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
    const key = await jose.importSPKI(pem, "EdDSA")
    return (await jose.jwtVerify(token, key, {issuer: "cloud-core", audience: packageName})).payload
  }

  // The licenses are in their term for the real clock, as they are for a phone minting now.
  const inTerm = {validFrom: new Date(Date.now() - DAY), paidThrough: new Date(Date.now() + 30 * DAY)}

  test("carries a personal license's features in that package's token only", async () => {
    await personal("mu_alice", inTerm)

    expect((await mint(CALL)).features).toEqual([UNLIMITED])
    expect("features" in (await mint(NOTES))).toBe(false)
  })

  test("carries a seat's features", async () => {
    await workspaceLicense("ws_acme", ["mu_alice"], inTerm)

    expect(await mint(CALL)).toMatchObject({sub: "mu_alice", aud: CALL, features: [UNLIMITED]})
  })

  test("has no features claim for a person with no license", async () => {
    expect("features" in (await mint(CALL))).toBe(false)
  })

  test("has no features claim for a person whose license has expired", async () => {
    await personal("mu_alice", {validFrom: new Date(Date.now() - 40 * DAY), paidThrough: new Date(Date.now() - DAY)})
    expect("features" in (await mint(CALL))).toBe(false)
  })

  test("has no features claim for a person whose license has a feature for no package", async () => {
    await personal("mu_alice", {...inTerm, features: [{key: "service.only", packages: []}]})
    expect("features" in (await mint(CALL))).toBe(false)
  })

  test("carries a configured grant to a person who holds no license", async () => {
    restoreEnv()
    restoreEnv = applyEnv({CLOUD_CORE_ENABLED_FEATURES: "call.unlimited:com.mentra.call"})

    expect((await mint(CALL)).features).toEqual([UNLIMITED])
    expect("features" in (await mint(NOTES))).toBe(false)
  })
})
