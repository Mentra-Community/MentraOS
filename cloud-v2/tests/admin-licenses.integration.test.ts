/**
 * @fileoverview The admin portal's license list (`GET /api/admin/licenses`) and the Licenses entry in
 * `GET /api/admin/me`.
 *
 * These drive the real Core app (`createApp`) at `/api/admin`, with the real principal middleware, services
 * and models against a local replica set. One boundary is faked: the identity provider (`support/fake-idp.ts`),
 * which signs the access tokens people present as bearers. People reach the admin API with an admin portal
 * session cookie or a bearer; workspace keys (`msk_`) and operator keys (`mak_`) are real rows made through
 * the public APIs; a phone token comes from Core's own token exchange. Licenses are rows seeded straight into
 * the collection, as billing's writes leave them.
 *
 * What it pins: an Organization Admin lists every license, workspace and personal, newest first, each with its
 * owner shown by name or email, its product, quantity, seats used, paid-through date and ended state; the
 * owners of a page are looked up in one batch per collection; search matches the owner's name or email, the
 * owner's id or the product as plain text, and pages with the same cursor; a workspace admin, an operator key
 * (every scope included), a workspace key and a phone token are refused; the route is read-only; and `/me`
 * says whether the Licenses page has anything to offer.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The
 * database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/admin-licenses.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {RevokedJtiModel} from "../packages/core/src/models/revoked-jti.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createSession} from "../packages/core/src/services/session.service"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {OPERATOR_KEY_SCOPES, type AdminLicenseView, type AdminLicensesResponse} from "../packages/workspace-contract/src/index"
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
  BrowserSessionModel,
  LicenseModel,
  LicenseSeatModel,
  RefreshTokenModel,
  RevokedJtiModel,
  SigninIdentityModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as const

const LICENSES = "/api/admin/licenses"

/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_BILLING_URL: undefined,
  CLOUD_CORE_BILLING_SECRET: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENVIRONMENT: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: "https://core.example.test/invite/{token}",
  RESEND_API_KEY: undefined,
  REFRESH_TOKEN_PEPPER: "admin-licenses-test-pepper",
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- Fixtures --------------------------------------------------------------

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
  opts: {as?: Person | string; via?: "session" | "bearer"; body?: unknown} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  const as = opts.as
  if (typeof as === "string") headers.authorization = `Bearer ${as}`
  else if (as && opts.via === "bearer") headers.authorization = `Bearer ${as.bearer}`
  else if (as) {
    headers.cookie = as.cookie
    if (method !== "GET" && method !== "HEAD") headers.origin = ADMIN_ORIGIN
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers["content-type"] = "application/json"
  }
  const response = await app.request(`${ADMIN_ORIGIN}${path}`, {method, headers, body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed status assertion rather than a parse error.
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

let sequence = 0
/** A license id in billing's ULID shape (26 characters) that sorts after every earlier one. */
const nextLicenseId = () => `01K${String(++sequence).padStart(23, "0")}`

type OwnerRow = {type: "workspace"; workspaceId: string} | {type: "person"; mentraUserId: string}

function licenseDoc(owner: OwnerRow, overrides: Record<string, unknown> = {}) {
  return {
    _id: nextLicenseId(),
    owner,
    product: "mentra.call.unlimited",
    features: [{key: "call.unlimited", packages: ["com.mentra.call"]}],
    quantity: owner.type === "person" ? 1 : 10,
    seatsUsed: owner.type === "person" ? 1 : 0,
    validFrom: new Date("2026-10-01T00:00:00.000Z"),
    paidThrough: new Date("2099-01-31T00:00:00.000Z"),
    revision: 1,
    endedAt: null,
    endedReason: null,
    ...overrides,
  }
}

async function seedLicense(owner: OwnerRow, overrides: Record<string, unknown> = {}): Promise<string> {
  const doc = licenseDoc(owner, overrides)
  await LicenseModel.create(doc)
  return doc._id
}

/** The workspaces and people the named licenses below belong to. */
async function seedOwners() {
  await WorkspaceModel.create([
    {workspaceId: "ws_acme", name: "Acme Robotics"},
    {workspaceId: "ws_closed", name: "Closed Down", status: "deleted", deletedAt: new Date("2026-09-01T00:00:00.000Z")},
  ])
  await SigninIdentityModel.create({
    mentraUserId: "mu_ada",
    tenantId: "mentra",
    sourceId: "mentra",
    subject: "supa-ada",
    email: "ada@analytical.test",
    emailVerified: true,
    name: "Ada Lovelace",
    signedInAt: new Date(),
  })
  await AccountEmailModel.create([
    {mentraUserId: "mu_grace", email: "grace@navy.test", checkedAt: new Date()},
    {mentraUserId: "mu_gone", email: null, deletedAt: new Date("2026-09-02T00:00:00.000Z"), checkedAt: new Date()},
  ])
}

/** One license for every kind of owner and state, oldest first; `seedNamedLicenses` returns their ids in that order. */
async function seedNamedLicenses() {
  await seedOwners()
  const acme = await seedLicense({type: "workspace", workspaceId: "ws_acme"}, {quantity: 10, seatsUsed: 4})
  const ada = await seedLicense({type: "person", mentraUserId: "mu_ada"})
  const grace = await seedLicense({type: "person", mentraUserId: "mu_grace"})
  const unknown = await seedLicense({type: "person", mentraUserId: "mu_unknown"})
  const closed = await seedLicense(
    {type: "workspace", workspaceId: "ws_closed"},
    {quantity: 3, seatsUsed: 2, endedAt: new Date("2026-09-01T00:00:00.000Z"), endedReason: "workspace_deleted"},
  )
  const gone = await seedLicense(
    {type: "person", mentraUserId: "mu_gone"},
    {endedAt: new Date("2026-09-02T00:00:00.000Z"), endedReason: "account_deleted"},
  )
  const expired = await seedLicense(
    {type: "workspace", workspaceId: "ws_acme"},
    {product: "mentra.notes.pro", quantity: 2, seatsUsed: 2, paidThrough: new Date("2020-03-15T00:00:00.000Z")},
  )
  return {acme, ada, grace, unknown, closed, gone, expired}
}

const idsOf = (reply: Reply) => (reply.json as AdminLicensesResponse).items.map(item => item.licenseId)

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("admin-licenses")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would silently win.
  // Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations do not run here; the transactions need their collections and indexes.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv(TEST_ENV)
  // Core's signing keys are read from the environment on first use; other suites in this process set their own.
  resetCoreKeyCaches()
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  sequence = 0
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
  app = createApp({readinessChecks: []})
})

afterEach(() => {
  idp.restore()
  restoreEnv()
  resetCoreKeyCaches()
})

// --- The list --------------------------------------------------------------

describe("GET /api/admin/licenses", () => {
  test("an Organization Admin sees every license, workspace and personal, newest first, each with who holds it", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const via of ["session", "bearer"] as const) {
      const reply = await call("GET", LICENSES, {as: admin, via})

      expect([via, reply.status]).toEqual([via, 200])
      const expected: AdminLicenseView[] = [
        {
          licenseId: ids.expired,
          owner: {type: "workspace", workspaceId: "ws_acme", name: "Acme Robotics"},
          product: "mentra.notes.pro",
          quantity: 2,
          seatsUsed: 2,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2020-03-15T00:00:00.000Z",
          endedAt: null,
          endedReason: null,
        },
        {
          licenseId: ids.gone,
          // The account is deleted: Core keeps no name or email for it.
          owner: {type: "person", mentraUserId: "mu_gone", name: null, email: null},
          product: "mentra.call.unlimited",
          quantity: 1,
          seatsUsed: 1,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: "2026-09-02T00:00:00.000Z",
          endedReason: "account_deleted",
        },
        {
          licenseId: ids.closed,
          owner: {type: "workspace", workspaceId: "ws_closed", name: "Closed Down"},
          product: "mentra.call.unlimited",
          quantity: 3,
          seatsUsed: 2,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: "2026-09-01T00:00:00.000Z",
          endedReason: "workspace_deleted",
        },
        {
          licenseId: ids.unknown,
          owner: {type: "person", mentraUserId: "mu_unknown", name: null, email: null},
          product: "mentra.call.unlimited",
          quantity: 1,
          seatsUsed: 1,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: null,
          endedReason: null,
        },
        {
          licenseId: ids.grace,
          // Never signed in through Core's sign-in server, but Core has her verified email.
          owner: {type: "person", mentraUserId: "mu_grace", name: null, email: "grace@navy.test"},
          product: "mentra.call.unlimited",
          quantity: 1,
          seatsUsed: 1,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: null,
          endedReason: null,
        },
        {
          licenseId: ids.ada,
          owner: {type: "person", mentraUserId: "mu_ada", name: "Ada Lovelace", email: "ada@analytical.test"},
          product: "mentra.call.unlimited",
          quantity: 1,
          seatsUsed: 1,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: null,
          endedReason: null,
        },
        {
          licenseId: ids.acme,
          owner: {type: "workspace", workspaceId: "ws_acme", name: "Acme Robotics"},
          product: "mentra.call.unlimited",
          quantity: 10,
          seatsUsed: 4,
          validFrom: "2026-10-01T00:00:00.000Z",
          paidThrough: "2099-01-31T00:00:00.000Z",
          endedAt: null,
          endedReason: null,
        },
      ]
      expect(reply.json).toEqual({items: expected, next: null})
    }
  })

  test("a Core with no licenses answers an empty list", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    expect((await call("GET", LICENSES, {as: admin})).json).toEqual({items: [], next: null})
  })

  test("an owner is read from the sign-in identity first and from Core's copy of the email otherwise", async () => {
    await seedOwners()
    await AccountEmailModel.create({mentraUserId: "mu_ada", email: "ada-old@analytical.test", checkedAt: new Date()})
    await seedLicense({type: "person", mentraUserId: "mu_ada"})
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await call("GET", LICENSES, {as: admin})

    expect(reply.json.items[0].owner).toEqual({
      type: "person",
      mentraUserId: "mu_ada",
      name: "Ada Lovelace",
      email: "ada@analytical.test",
    })
  })

  test("the owners of a page are looked up in one batch per collection, not one per row", async () => {
    await seedOwners()
    const docs = []
    for (let i = 0; i < 20; i++) {
      await WorkspaceModel.create({workspaceId: `ws_batch_${i}`, name: `Batch ${i}`})
      docs.push(licenseDoc({type: "workspace", workspaceId: `ws_batch_${i}`}))
      docs.push(licenseDoc({type: "person", mentraUserId: `mu_batch_${i}`}))
    }
    await LicenseModel.insertMany(docs)
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const workspaces = spyOn(WorkspaceModel, "find")
    const workspaceOne = spyOn(WorkspaceModel, "findOne")
    const identities = spyOn(SigninIdentityModel, "find")
    const identityOne = spyOn(SigninIdentityModel, "findOne")
    const emails = spyOn(AccountEmailModel, "find")
    const emailOne = spyOn(AccountEmailModel, "findOne")
    try {
      const before = [workspaces, identities, emails].map(spy => spy.mock.calls.length)

      const reply = await call("GET", LICENSES, {as: admin})

      expect(reply.status).toBe(200)
      expect(reply.json.items).toHaveLength(40)
      expect([workspaces, identities, emails].map((spy, index) => spy.mock.calls.length - before[index]!)).toEqual([1, 1, 1])
      expect([workspaceOne, identityOne, emailOne].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0])
      expect(reply.json.items.find((item: AdminLicenseView) => item.owner.type === "workspace" && item.owner.workspaceId === "ws_batch_7").owner.name).toBe(
        "Batch 7",
      )
    } finally {
      for (const spy of [workspaces, workspaceOne, identities, identityOne, emails, emailOne]) spy.mockRestore()
    }
  })

  test("pages by cursor, 50 at a time, and the last page has no next", async () => {
    const docs = Array.from({length: 120}, () => licenseDoc({type: "person", mentraUserId: `mu_page_${sequence}`}))
    await LicenseModel.insertMany(docs)
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const first = await call("GET", LICENSES, {as: admin})
    expect(first.json.items).toHaveLength(50)
    expect(first.json.next).toBe(first.json.items[49].licenseId)
    const second = await call("GET", `${LICENSES}?cursor=${encodeURIComponent(first.json.next)}`, {as: admin})
    expect(second.json.items).toHaveLength(50)
    expect(second.json.next).toBe(second.json.items[49].licenseId)
    const third = await call("GET", `${LICENSES}?cursor=${encodeURIComponent(second.json.next)}`, {as: admin})
    expect(third.json.items).toHaveLength(20)
    expect(third.json.next).toBeNull()

    const walked = [...idsOf(first), ...idsOf(second), ...idsOf(third)]
    expect(walked).toEqual(docs.map(doc => doc._id).reverse())
  })

  test("a list of exactly one page has no next", async () => {
    await LicenseModel.insertMany(Array.from({length: 50}, () => licenseDoc({type: "person", mentraUserId: `mu_full_${sequence}`})))
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await call("GET", LICENSES, {as: admin})

    expect(reply.json.items).toHaveLength(50)
    expect(reply.json.next).toBeNull()
  })

  test("a license written after a page was read does not shift the next page", async () => {
    await LicenseModel.insertMany(Array.from({length: 60}, () => licenseDoc({type: "person", mentraUserId: `mu_shift_${sequence}`})))
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const first = await call("GET", LICENSES, {as: admin})

    await seedLicense({type: "person", mentraUserId: "mu_late"})
    const second = await call("GET", `${LICENSES}?cursor=${encodeURIComponent(first.json.next)}`, {as: admin})

    expect(second.json.items).toHaveLength(10)
    expect(idsOf(second).some(id => idsOf(first).includes(id))).toBe(false)
    expect(second.json.next).toBeNull()
  })

  test("a request that is not a read is refused: there is no route to change a license or its seats", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const before = await LicenseModel.find({}).sort({_id: 1}).lean()

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of [LICENSES, `${LICENSES}/${ids.acme}`, `${LICENSES}/${ids.acme}/seats`]) {
        const reply = await call(method, path, {as: admin, body: {quantity: 99}})
        expect([method, path, reply.status]).toEqual([method, path, 404])
      }
    }

    expect(await LicenseModel.find({}).sort({_id: 1}).lean()).toEqual(before)
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)
  })
})

// --- Search ----------------------------------------------------------------

describe("GET /api/admin/licenses?query=", () => {
  async function search(query: string, admin: Person, cursor?: string): Promise<Reply> {
    const params = new URLSearchParams({query})
    if (cursor) params.set("cursor", cursor)
    return call("GET", `${LICENSES}?${params}`, {as: admin})
  }

  test("matches a workspace by its name, ignoring case and surrounding spaces", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect(idsOf(await search("acme", admin))).toEqual([ids.expired, ids.acme])
    expect(idsOf(await search("  ROBOTICS  ", admin))).toEqual([ids.expired, ids.acme])
    expect(idsOf(await search("closed down", admin))).toEqual([ids.closed])
  })

  test("matches a person by name or by email, from the sign-in identity or Core's copy of the email", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect(idsOf(await search("lovelace", admin))).toEqual([ids.ada])
    expect(idsOf(await search("ANALYTICAL.TEST", admin))).toEqual([ids.ada])
    expect(idsOf(await search("grace@navy", admin))).toEqual([ids.grace])
  })

  test("matches the product", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect(idsOf(await search("notes.pro", admin))).toEqual([ids.expired])
    expect(idsOf(await search("mentra.call", admin))).toEqual([ids.gone, ids.closed, ids.unknown, ids.grace, ids.ada, ids.acme])
  })

  test("matches an owner Core knows no name for by its id", async () => {
    const ids = await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect(idsOf(await search("mu_unknown", admin))).toEqual([ids.unknown])
    expect(idsOf(await search("ws_closed", admin))).toEqual([ids.closed])
  })

  test("a query that matches nothing is an empty list, and a blank one is the whole list", async () => {
    await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect((await search("no such owner", admin)).json).toEqual({items: [], next: null})
    expect(idsOf(await search("   ", admin))).toHaveLength(7)
    expect(idsOf(await call("GET", `${LICENSES}?query=`, {as: admin}))).toHaveLength(7)
  })

  test("is plain text, never a pattern", async () => {
    await seedNamedLicenses()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const query of [".*", "^acme", "acme$", "(", "[a-z]+", "mentra.call.unl.*", "{$ne: null}"]) {
      const reply = await search(query, admin)
      expect([query, reply.status, reply.json.items]).toEqual([query, 200, []])
    }
  })

  test("pages a search with the same cursor", async () => {
    await WorkspaceModel.create({workspaceId: "ws_bulk", name: "Bulk Co"})
    await seedNamedLicenses()
    const bulk = Array.from({length: 70}, () => licenseDoc({type: "workspace", workspaceId: "ws_bulk"}))
    await LicenseModel.insertMany(bulk)
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const first = await search("bulk co", admin)
    expect(first.json.items).toHaveLength(50)
    const second = await search("bulk co", admin, first.json.next)
    expect(second.json.items).toHaveLength(20)
    expect(second.json.next).toBeNull()
    expect([...idsOf(first), ...idsOf(second)]).toEqual(bulk.map(doc => doc._id).reverse())
  })

  test("refuses a search text or a cursor longer than it could ever be", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const long = await search("x".repeat(101), admin)
    expect(long.status).toBe(400)
    expect(long.json.error).toBe("invalid_request")
    expect((await search("x".repeat(100), admin)).status).toBe(200)

    const badCursor = await call("GET", `${LICENSES}?cursor=${"y".repeat(65)}`, {as: admin})
    expect(badCursor.status).toBe(400)
    expect(badCursor.json.error).toBe("invalid_request")
  })

  test("never surfaces a workspace or a person who holds no license", async () => {
    await seedNamedLicenses()
    // Their names match, but there is no license of theirs to list.
    await WorkspaceModel.create({workspaceId: "ws_unlicensed", name: "Unlicensed Works"})
    await SigninIdentityModel.create({
      mentraUserId: "mu_unlicensed",
      tenantId: "mentra",
      sourceId: "mentra",
      subject: "supa-unlicensed",
      email: "nolicense@example.test",
      emailVerified: true,
      name: "No License",
      signedInAt: new Date(),
    })
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect((await search("unlicensed", admin)).json.items).toEqual([])
    expect((await search("nolicense", admin)).json.items).toEqual([])
  })
})

// --- Who may read ----------------------------------------------------------

describe("who may read the license list", () => {
  test("a workspace admin, an operator key, a workspace key and a phone token are refused", async () => {
    await seedNamedLicenses()
    const ws = await workspaceWithPeople()
    // Every scope an operator key can carry.
    const operator = await operatorKey("all-scopes", [...OPERATOR_KEY_SCOPES])
    const phone = await phoneToken("holder")

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
      for (const path of [LICENSES, `${LICENSES}?query=acme`]) {
        const reply = await call("GET", path, {as: caller, via})
        expect([label, path, reply.status]).toEqual([label, path, status])
        // Nothing of any license is in a refusal.
        expect([label, reply.text.includes("Acme Robotics")]).toEqual([label, false])
        expect([label, reply.text.includes("ada@analytical.test")]).toEqual([label, false])
      }
    }
    expect((await call("GET", LICENSES)).status).toBe(401)
    expect((await call("GET", LICENSES, {as: "mak_local_notakey"})).status).toBe(401)
  })

  test("an allowlisted address the identity provider has not verified is refused", async () => {
    await seedNamedLicenses()
    const claimed = await person("claimed", {email: ADMIN_EMAIL, emailVerified: false})

    for (const via of ["session", "bearer"] as const) {
      expect([via, (await call("GET", LICENSES, {as: claimed, via})).status]).toEqual([via, 403])
    }
  })

  test("an operator key is refused for want of a scope it can never hold, not for lack of one it was given", async () => {
    const operator = await operatorKey("all-scopes", [...OPERATOR_KEY_SCOPES])
    const me = await call("GET", "/api/admin/me", {as: operator})

    expect(me.json.organization.capabilities).not.toContain("organization.licenses.read")
    expect(me.json.licenses).toEqual({available: false})
  })
})

// --- /me -------------------------------------------------------------------

describe("GET /api/admin/me says whether the Licenses page has anything to offer", () => {
  test("not on a Core with no billing and no licenses", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const reply = await call("GET", "/api/admin/me", {as: admin})

    expect(reply.status).toBe(200)
    expect(reply.json.licenses).toEqual({available: false})
  })

  test("once a license exists, whatever its owner", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    await seedLicense({type: "person", mentraUserId: "mu_ada"})

    for (const via of ["session", "bearer"] as const) {
      expect((await call("GET", "/api/admin/me", {as: admin, via})).json.licenses).toEqual({available: true})
    }
  })

  test("once billing is configured, even with no license yet", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    process.env.CLOUD_CORE_BILLING_URL = "https://billing.example.test"
    process.env.CLOUD_CORE_BILLING_SECRET = "billing-secret"

    const reply = await call("GET", "/api/admin/me", {as: admin})

    expect(reply.json.licenses).toEqual({available: true})
    expect(reply.text).not.toContain("billing.example.test")
    expect(reply.text).not.toContain("billing-secret")
  })

  test("not for a person who cannot read licenses, however many exist", async () => {
    await seedNamedLicenses()
    process.env.CLOUD_CORE_BILLING_URL = "https://billing.example.test"
    process.env.CLOUD_CORE_BILLING_SECRET = "billing-secret"
    const ws = await workspaceWithPeople()

    for (const caller of [ws.owner, ws.admin]) {
      expect((await call("GET", "/api/admin/me", {as: caller})).json.licenses).toEqual({available: false})
    }
    expect((await call("GET", "/api/admin/me", {as: ws.workspaceKey})).json.licenses).toEqual({available: false})
  })
})
