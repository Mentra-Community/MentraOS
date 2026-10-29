/**
 * @fileoverview Licenses and seats in Core.
 *
 * Billing (the Store's billing module) writes licenses through the signed service API at
 * `/api/internal/licenses`, with the contract's `createCoreWorkspaceClient` driving the real app; people
 * see licenses and assign seats through the workspace routes, with Core access tokens from a fake
 * identity provider (`support/fake-idp.ts`). The workspace lifecycle that frees seats and ends licenses
 * (removing a member, leaving, deleting a workspace, deleting an account) runs through the real services.
 * Licenses, seats, memberships and audit events are real rows on a local replica set, so the seat cap's
 * transaction meets real write conflicts.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The
 * database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/licenses.integration.test.ts`
 */

import {randomBytes} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  WORKSPACE_AUDIT_COUNTER_ID,
  WorkspaceAuditCounterModel,
} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {
  assignSeat,
  assignSeats,
  listWorkspaceLicenses,
  releaseSeat,
} from "../packages/core/src/services/licenses/license.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {finishLicenseReset} from "../packages/core/src/services/licenses/workspace-license-reset.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {removeDeletedUserFromWorkspaces} from "../packages/core/src/services/workspaces/account-deletion.service"
import {
  recordWorkspaceEvent,
  recordWorkspaceEvents,
  type WorkspaceAuditEventInput,
} from "../packages/core/src/services/workspaces/audit.service"
import {createWorkspaceCredential} from "../packages/core/src/services/workspaces/credential.service"
import {
  bumpRevision,
  createWorkspace,
  deleteWorkspace,
  endMembership,
  getActiveMembership,
  getWorkspace,
  leaveWorkspace,
  removeMember,
  WorkspaceError,
  type Actor,
  type MembershipRow,
} from "../packages/core/src/services/workspaces/workspace.service"
import {
  CoreWorkspaceClientError,
  createCoreWorkspaceClient,
  SERVICE_HEADERS,
  signServiceRequest,
  type CoreWorkspaceClient,
  type LicenseOwner,
  type LicenseView,
  type LicenseWrite,
  type WorkspaceChangeEvent,
} from "../packages/workspace-contract/src/server"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
  ADMIN_EMAIL,
  applyEnv,
  coreAccessToken,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

// Twenty transactions contending for one license document retry each other's write conflicts.
setDefaultTimeout(60_000)

const MODELS = [
  AccessCredentialModel,
  LicenseModel,
  LicenseSeatModel,
  SigninIdentityModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const SERVICE_SECRETS = {store: ["store-s1"], fleet: ["fleet-f1"]}
const BASE = "https://core.test"
const LICENSES = "/api/internal/licenses"

/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENVIRONMENT: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_SERVICE_SECRETS: JSON.stringify(SERVICE_SECRETS),
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
  /** A Core access token, for `Authorization: Bearer`. */
  bearer: string
  mentraUserId: string
}

let counter = 0

/** A person with a confirmed Mentra account, a Core user and a Core access token. */
async function person(key: string, options: {email?: string} = {}): Promise<Person> {
  const n = counter++
  const sub = `supa-${key}-${n}`
  const email = options.email ?? `${key}-${n}@example.test`
  idp.registerUser({sub, email, emailConfirmed: true})
  const bearer = await coreAccessToken({sub, email, emailVerified: true})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {sub, email, bearer, mentraUserId}
}

function actorOf(p: Person, isOrganizationAdmin = false): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId: p.mentraUserId, email: p.email, emailVerified: true, isOrganizationAdmin}
}

/** An active membership written directly, as an accepted invitation leaves one. */
async function addMember(workspaceId: string, who: {mentraUserId: string; email?: string | null}, role: string) {
  const membershipId = `wm_lic_${counter++}`
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId: who.mentraUserId,
      email: who.email ?? null,
      role,
      status: "active",
      startedAt: new Date(),
    }),
  )
  return membershipId
}

/** `n` more members, each a distinct person. */
async function addMembers(workspaceId: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await addMember(workspaceId, {mentraUserId: `mu_seat_${counter++}`}, "member"))
  return ids
}

/** A workspace with an owner, an admin, a developer and a plain member, and a stranger who belongs to none. */
async function newWorkspace(name = "Acme") {
  const owner = await person("owner")
  const admin = await person("admin")
  const developer = await person("developer")
  const member = await person("member")
  const stranger = await person("stranger")
  const {workspaceId} = await createWorkspace(actorOf(owner), {name})
  const ownerMembershipId = (await getActiveMembership(workspaceId, owner.mentraUserId))!.membershipId
  return {
    workspaceId,
    name,
    owner,
    admin,
    developer,
    member,
    stranger,
    ownerMembershipId,
    adminMembershipId: await addMember(workspaceId, admin, "admin"),
    developerMembershipId: await addMember(workspaceId, developer, "developer"),
    memberMembershipId: await addMember(workspaceId, member, "member"),
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/** A license id as billing mints it: a ULID. */
function newLicenseId(): string {
  return `0${[...randomBytes(25)].map((byte) => CROCKFORD[byte % 32]).join("")}`
}

function licenseWrite(owner: LicenseOwner, overrides: Partial<LicenseWrite> = {}): LicenseWrite {
  return {
    licenseId: newLicenseId(),
    revision: 1,
    owner,
    product: "mentra.call.unlimited",
    features: [{key: "call.unlimited", packages: ["com.mentra.call"]}],
    quantity: 5,
    validFrom: "2026-10-01T00:00:00.000Z",
    paidThrough: "2026-11-04T00:00:00.000Z",
    ...overrides,
  }
}

/** A write naming a person as the owner, as billing once sent for a personal license: no license can have one. */
function personWrite(mentraUserId: string): Record<string, unknown> {
  return {...licenseWrite({type: "workspace", workspaceId: "ws_none"}), owner: {type: "person", mentraUserId}, quantity: 1}
}

/** A workspace license billing has written. */
async function workspaceLicense(workspaceId: string, overrides: Partial<LicenseWrite> = {}): Promise<LicenseWrite> {
  const write = licenseWrite({type: "workspace", workspaceId}, overrides)
  expect(await store().putLicense(write)).toEqual({applied: true, revision: write.revision})
  return write
}

/** The license as Core shows it, without seats. */
function viewOf(write: LicenseWrite, fields: {seatsUsed: number; endedAt?: string | null}): LicenseView {
  // Whom billing named to assign, and a seat request, are the write's, not the license's.
  const {licenseId, assignTo: _assignTo, seatRequest: _seatRequest, ...rest} = write
  return {licenseId, ...rest, seatsUsed: fields.seatsUsed, endedAt: fields.endedAt ?? null}
}

const licenseRow = (licenseId: string) => LicenseModel.findById(licenseId).lean()
const seatsOf = (licenseId: string) => LicenseSeatModel.find({licenseId}).sort({membershipId: 1}).lean()
const revisionOf = async (workspaceId: string) => (await getWorkspace(workspaceId))!.authorizationRevision

async function markAccountDeleted(mentraUserId: string) {
  await UserModel.updateOne({mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
}

/** The whole change feed, oldest first. */
async function feed(): Promise<WorkspaceChangeEvent[]> {
  const events: WorkspaceChangeEvent[] = []
  let after: string | null = null
  for (;;) {
    const page = await store().listChanges({after, limit: 500})
    events.push(...page.events)
    if (!page.next) return events
    after = page.next
  }
}

const audit = (action: string) => WorkspaceAuditEventModel.find({action}).sort({eventId: 1}).lean()

/** The WorkspaceError a refused service call raised, or the call's result as a failure. */
async function refusal(promise: Promise<unknown>): Promise<WorkspaceError> {
  const error = await promise.then(
    (result) => new Error(`resolved: ${JSON.stringify(result)}`),
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(WorkspaceError)
  return error as WorkspaceError
}

// --- Calling the app -------------------------------------------------------

const coreFetch = ((input: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch

function clientFor(service: string, secret: string): CoreWorkspaceClient {
  return createCoreWorkspaceClient({baseUrl: BASE, service, secret, fetch: coreFetch})
}

const store = () => clientFor("store", "store-s1")
const fleet = () => clientFor("fleet", "fleet-f1")

describe("staging administrative license resets", () => {
  test("a failed first delivery stays retired after reset while a genuinely new purchase still works", async () => {
    const previous = process.env.CLOUD_CORE_ENVIRONMENT
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    try {
      const target = await newWorkspace("First delivery still pending")
      const delayed = licenseWrite({type: "workspace", workspaceId: target.workspaceId}, {assignTo: {mentraUserId: target.owner.mentraUserId}})
      expect(await licenseRow(delayed.licenseId)).toBeNull()
      await finishLicenseReset(actorOf(target.owner, true), target.workspaceId, "Restart pending checkout test", {licenseIds: [delayed.licenseId], canceledSubscriptions: 1, expiredCheckouts: 0})
      await expectClientError(store().putLicense(delayed), "owner_not_found", 404)
      expect(await licenseRow(delayed.licenseId)).toBeNull()
      expect(await seatsOf(delayed.licenseId)).toHaveLength(0)
      const fresh = await workspaceLicense(target.workspaceId, {assignTo: {mentraUserId: target.owner.mentraUserId}})
      expect(await seatsOf(fresh.licenseId)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = previous
    }
  })
  test("ends only the target's licenses, releases seats, preserves members and rejects delayed writes", async () => {
    const previous = process.env.CLOUD_CORE_ENVIRONMENT
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    try {
      const target = await newWorkspace("Reset target")
      const other = await newWorkspace("Keep this workspace")
      const license = await workspaceLicense(target.workspaceId)
      const kept = await workspaceLicense(other.workspaceId)
      await assignSeat(actorOf(target.owner), target.workspaceId, license.licenseId, target.ownerMembershipId)
      const result = await finishLicenseReset(actorOf(target.owner, true), target.workspaceId, "Restart subscription testing", {licenseIds: [license.licenseId], canceledSubscriptions: 1, expiredCheckouts: 1})
      expect(result).toMatchObject({endedProducts: 1, releasedAssignments: 1})
      expect(await licenseRow(license.licenseId)).toMatchObject({endedAt: expect.any(Date), endedReason: "admin_reset", seatsUsed: 0})
      expect(await seatsOf(license.licenseId)).toHaveLength(0)
      expect((await getActiveMembership(target.workspaceId, target.owner.mentraUserId))?.membershipId).toBe(target.ownerMembershipId)
      expect((await getWorkspace(target.workspaceId))?.status).toBe("active")
      expect((await licenseRow(kept.licenseId))?.endedAt).toBeNull()
      await expectClientError(store().putLicense({...license, revision: license.revision + 1}), "owner_not_found", 404)
      expect((await workspaceLicense(target.workspaceId)).licenseId).not.toBe(license.licenseId)
      expect((await audit("workspace.licenses.reset"))[0]?.after).toMatchObject({reason: "Restart subscription testing"})
    } finally {
      if (previous === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = previous
    }
  })
  test("a newly arrived license outside the canceled snapshot aborts cleanup without ending it", async () => {
    const previous = process.env.CLOUD_CORE_ENVIRONMENT
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    try {
      const target = await newWorkspace()
      const license = await workspaceLicense(target.workspaceId)
      expect((await refusal(finishLicenseReset(actorOf(target.owner, true), target.workspaceId, "Restart subscription testing", {licenseIds: [], canceledSubscriptions: 0, expiredCheckouts: 0}))).code).toBe("membership_changed")
      expect((await licenseRow(license.licenseId))?.endedAt).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLOUD_CORE_ENVIRONMENT; else process.env.CLOUD_CORE_ENVIRONMENT = previous
    }
  })
})

async function expectClientError(promise: Promise<unknown>, code: CoreWorkspaceClientError["code"], status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CoreWorkspaceClientError)
  expect({code: (error as CoreWorkspaceClientError).code, status: (error as CoreWorkspaceClientError).status}).toEqual({
    code,
    status,
  })
}

interface Reply {
  status: number
  json: any
}

async function reply(response: Response): Promise<Reply> {
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body shows up as a failed assertion on its status.
  }
  return {status: response.status, json}
}

/** One service request through the real app, signed by `service` unless `signed` is false. */
async function signed(
  method: "GET" | "PUT",
  pathWithQuery: string,
  options: {service?: string; secret?: string; body?: unknown; signed?: boolean} = {},
): Promise<Reply> {
  const body = options.body === undefined ? "" : JSON.stringify(options.body)
  const timestampMs = Date.now()
  const headers: Record<string, string> =
    options.signed === false
      ? {}
      : {
          [SERVICE_HEADERS.service]: options.service ?? "store",
          [SERVICE_HEADERS.timestamp]: String(timestampMs),
          [SERVICE_HEADERS.signature]: signServiceRequest({
            secret: options.secret ?? "store-s1",
            method,
            pathWithQuery,
            body,
            timestampMs,
          }),
        }
  if (method === "PUT") headers["content-type"] = "application/json"
  return reply(
    await app.fetch(
      new Request(`${BASE}${pathWithQuery}`, {method, headers, body: method === "PUT" ? body : undefined}),
    ),
  )
}

/** One request to the workspace routes as `as` (a person's bearer, or a raw bearer token), with `body` as JSON. */
async function call(method: string, path: string, as?: Person | string, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (typeof as === "string") headers.authorization = `Bearer ${as}`
  else if (as) headers.authorization = `Bearer ${as.bearer}`
  if (body !== undefined) headers["content-type"] = "application/json"
  return reply(
    await app.request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

const seatPath = (workspaceId: string, licenseId: string, membershipId: string) =>
  `/api/workspaces/${workspaceId}/licenses/${licenseId}/seats/${membershipId}`

/** The workspace portal's route for several seats at once. */
const seatAssignmentsPath = (workspaceId: string) => `/api/portal/workspaces/${workspaceId}/seat-assignments`

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("licenses")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would
  // silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations do not run here; the transactions need their collections and indexes.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
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
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
  resetIdpTokenCaches()
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

// --- The collections -------------------------------------------------------

describe("collections", () => {
  test("licenses are found by their workspace, and a seat is unique per license and membership", async () => {
    const keys = async (model: typeof LicenseModel | typeof LicenseSeatModel) =>
      (await model.collection.indexes()).map((index) => ({key: index.key, unique: index.unique === true}))
    expect(LicenseModel.collection.collectionName).toBe("licenses")
    expect(LicenseSeatModel.collection.collectionName).toBe("license_seats")
    expect(await keys(LicenseModel)).toEqual(
      expect.arrayContaining([
        {key: {"owner.type": 1, "owner.workspaceId": 1}, unique: false},
      ]),
    )
    // No license is a person's, so none is looked up by one.
    expect(LicenseModel.schema.indexes().map(([key]) => key)).toEqual([{"owner.type": 1, "owner.workspaceId": 1}])
    expect(await keys(LicenseSeatModel)).toEqual(
      expect.arrayContaining([
        {key: {licenseId: 1, membershipId: 1}, unique: true},
        {key: {mentraUserId: 1}, unique: false},
        {key: {workspaceId: 1}, unique: false},
      ]),
    )
  })
})

// --- The license-write API -------------------------------------------------

describe("license writes", () => {
  test("a newer revision applies, an equal one is a 200 no-op, and an older one is 409 stale_revision", async () => {
    const {workspaceId} = await newWorkspace()
    const first = licenseWrite({type: "workspace", workspaceId}, {revision: 2})

    expect(await store().putLicense(first)).toEqual({applied: true, revision: 2})
    expect(await store().listLicenses(workspaceId)).toEqual({
      licenses: [viewOf(first, {seatsUsed: 0})],
    })

    // The same revision again, even with other content, changes nothing.
    expect(await store().putLicense({...first, quantity: 9})).toEqual({applied: false, revision: 2})
    expect((await licenseRow(first.licenseId))!.quantity).toBe(5)

    const renewed = {...first, revision: 3, quantity: 7, paidThrough: "2026-12-04T00:00:00.000Z"}
    expect(await store().putLicense(renewed)).toEqual({applied: true, revision: 3})
    expect(await store().listLicenses(workspaceId)).toEqual({
      licenses: [viewOf(renewed, {seatsUsed: 0})],
    })

    // An older revision arriving late is refused, and says which revision Core has.
    await expectClientError(store().putLicense({...first, revision: 1}), "stale_revision", 409)
    const late = await signed("PUT", `${LICENSES}/${first.licenseId}`, {body: {...first, revision: 1}})
    expect(late).toMatchObject({status: 409, json: {error: "stale_revision", revision: 3}})
    expect(await store().listLicenses(workspaceId)).toEqual({
      licenses: [viewOf(renewed, {seatsUsed: 0})],
    })

    // Two writes applied, two events.
    expect((await audit("license.written")).map((event) => event.after?.revision)).toEqual([2, 3])
  })

  test("only the Store writes and reads licenses: Fleet is 403 and an unsigned call is 401", async () => {
    const {workspaceId} = await newWorkspace()
    const write = licenseWrite({type: "workspace", workspaceId})

    await expectClientError(fleet().putLicense(write), "forbidden", 403)
    await expectClientError(fleet().listLicenses(workspaceId), "forbidden", 403)
    await expectClientError(clientFor("store", "not-the-secret").putLicense(write), "service_unauthorized", 401)

    const path = `${LICENSES}/${write.licenseId}`
    expect(await signed("PUT", path, {body: write, signed: false})).toEqual({
      status: 401,
      json: {error: "service_unauthorized"},
    })
    expect(await signed("GET", `${LICENSES}?ownerType=workspace&ownerId=${workspaceId}`, {signed: false})).toEqual({
      status: 401,
      json: {error: "service_unauthorized"},
    })
    expect(await signed("PUT", path, {body: write, service: "fleet", secret: "fleet-f1"})).toEqual({
      status: 403,
      json: {error: "forbidden"},
    })

    expect(await LicenseModel.countDocuments({})).toBe(0)
  })

  test("a write for a workspace that is deleted or never existed is 404 owner_not_found", async () => {
    const {workspaceId, owner, name} = await newWorkspace()
    await deleteWorkspace(actorOf(owner), workspaceId, {confirmName: name})

    for (const target of [
      {type: "workspace", workspaceId} as const,
      {type: "workspace", workspaceId: "ws_never"} as const,
    ]) {
      await expectClientError(store().putLicense(licenseWrite(target)), "owner_not_found", 404)
    }
    expect(await LicenseModel.countDocuments({})).toBe(0)
    expect(await audit("license.written")).toEqual([])
  })

  test("a license is a workspace's: a write for a person is 400 invalid_request, account or not, and Core keeps nothing", async () => {
    const someone = await person("someone")
    const gone = await person("gone")
    await markAccountDeleted(gone.mentraUserId)

    for (const mentraUserId of [someone.mentraUserId, gone.mentraUserId, "mu_never"]) {
      const write = personWrite(mentraUserId)
      expect(await signed("PUT", `${LICENSES}/${write.licenseId}`, {body: write})).toEqual({
        status: 400,
        json: {error: "invalid_request", error_description: 'owner must be {"type": "workspace", "workspaceId"}'},
      })
      await expectClientError(store().putLicense(write as unknown as LicenseWrite), "bad_request", 400)
      // Whatever it names, a quantity of 1 or a buyer: the owner is what refuses it.
      expect((await signed("PUT", `${LICENSES}/${write.licenseId}`, {body: {...write, assignTo: {mentraUserId}}})).status).toBe(400)
    }
    expect(await LicenseModel.countDocuments({})).toBe(0)
    expect(await audit("license.written")).toEqual([])
  })

  test("a malformed write is 400 invalid_request", async () => {
    const {workspaceId} = await newWorkspace()
    const negative = licenseWrite({type: "workspace", workspaceId}, {quantity: -1})

    const refused = await signed("PUT", `${LICENSES}/${negative.licenseId}`, {body: negative})
    expect(refused.status).toBe(400)
    expect(refused.json.error).toBe("invalid_request")
    await expectClientError(store().putLicense(negative), "bad_request", 400)

    // The body names another license than the path.
    const other = licenseWrite({type: "workspace", workspaceId})
    expect((await signed("PUT", `${LICENSES}/${newLicenseId()}`, {body: other})).status).toBe(400)
    // A body that is not JSON.
    expect((await signed("PUT", `${LICENSES}/${other.licenseId}`, {body: "nope"})).status).toBe(400)
    // A term that ends before it starts.
    const reversed = {...other, validFrom: "2026-11-04T00:00:00.000Z", paidThrough: "2026-10-01T00:00:00.000Z"}
    expect(await signed("PUT", `${LICENSES}/${other.licenseId}`, {body: reversed})).toMatchObject({
      status: 400,
      json: {error: "invalid_request"},
    })
    expect(await LicenseModel.countDocuments({})).toBe(0)
  })

  test("a license's owner never changes", async () => {
    const {workspaceId} = await newWorkspace()
    const other = await newWorkspace("Other")
    const someone = await person("someone")
    const write = await workspaceLicense(workspaceId)
    const moved = {...write, revision: 2, owner: {type: "workspace", workspaceId: other.workspaceId}} as LicenseWrite
    expect(await signed("PUT", `${LICENSES}/${write.licenseId}`, {body: moved})).toMatchObject({
      status: 400,
      json: {error: "invalid_request", error_description: "a license's owner never changes"},
    })
    const toPerson = {...personWrite(someone.mentraUserId), licenseId: write.licenseId, revision: 2}
    await expectClientError(store().putLicense(toPerson as unknown as LicenseWrite), "bad_request", 400)
    expect(await licenseRow(write.licenseId)).toMatchObject({owner: {type: "workspace", workspaceId}, revision: 1})
  })

  test("listLicenses answers one workspace's licenses, with seats used; any other owner type is 400", async () => {
    const acme = await newWorkspace("Acme")
    const other = await newWorkspace("Other")
    const first = await workspaceLicense(acme.workspaceId, {quantity: 3})
    const second = await workspaceLicense(acme.workspaceId, {quantity: 2, product: "mentra.fleet"})
    await workspaceLicense(other.workspaceId)
    await assignSeat(actorOf(acme.admin), acme.workspaceId, first.licenseId, acme.memberMembershipId)

    const listed = await store().listLicenses(acme.workspaceId)
    expect(listed.licenses.sort((a, b) => a.licenseId.localeCompare(b.licenseId))).toEqual(
      [viewOf(first, {seatsUsed: 1}), viewOf(second, {seatsUsed: 0})].sort((a, b) =>
        a.licenseId.localeCompare(b.licenseId),
      ),
    )
    expect(await store().listLicenses("ws_nobody")).toEqual({licenses: []})

    for (const query of [
      "",
      "?ownerType=workspace",
      "?ownerType=team&ownerId=ws_1",
      "?ownerType=person",
      "?ownerType=person&ownerId=",
      `?ownerType=person&ownerId=${acme.member.mentraUserId}`,
    ]) {
      expect({query, status: (await signed("GET", `${LICENSES}${query}`)).status}).toEqual({query, status: 400})
    }
  })
})

// --- Seats -----------------------------------------------------------------

describe("seats", () => {
  test("the seat cap holds: of 20 assignments of the last seat at once, exactly one succeeds", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
    for (const membershipId of [ws.ownerMembershipId, ws.adminMembershipId]) {
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
    }
    const contenders = await addMembers(ws.workspaceId, 20)

    const results = await Promise.allSettled(
      contenders.map((membershipId) => assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    expect(refusals.map((error) => (error instanceof WorkspaceError ? error.code : String(error)))).toEqual(
      Array(19).fill("no_seats_available"),
    )
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(3)
    expect(await seatsOf(license.licenseId)).toHaveLength(3)
  })

  test("20 assignments at once with 10 seats free: exactly 10 succeed, and none is refused for a write conflict", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 10})
    const contenders = await addMembers(ws.workspaceId, 20)

    const results = await Promise.allSettled(
      contenders.map((membershipId) => assignSeat(actorOf(ws.owner), ws.workspaceId, license.licenseId, membershipId)),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10)
    // Every refusal is the cap's: a conflict between the assignments is retried, never refused.
    const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    expect(refusals.map((error) => (error instanceof WorkspaceError ? error.code : String(error)))).toEqual(
      Array(10).fill("no_seats_available"),
    )
    const seats = await seatsOf(license.licenseId)
    expect(seats).toHaveLength(10)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(10)
    expect(await audit("seat.assigned")).toHaveLength(10)
  })

  test("a member holds at most one seat per license, however often it is assigned", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId)
    const other = await workspaceLicense(ws.workspaceId)

    const first = await call("PUT", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.admin)
    expect(first.status).toBe(200)
    const again = await call("PUT", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.admin)
    expect(again).toEqual(first)
    await Promise.all(
      Array.from({length: 5}, () =>
        assignSeat(actorOf(ws.owner), ws.workspaceId, license.licenseId, ws.memberMembershipId),
      ),
    )
    // A seat in another license is another seat.
    await assignSeat(actorOf(ws.owner), ws.workspaceId, other.licenseId, ws.memberMembershipId)

    expect(await seatsOf(license.licenseId)).toHaveLength(1)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(1)
    expect((await licenseRow(other.licenseId))!.seatsUsed).toBe(1)
    expect(await audit("seat.assigned")).toHaveLength(2)
    // The database refuses a second seat even if a writer ever tried one.
    const [seat] = await seatsOf(license.licenseId)
    const duplicate = await LicenseSeatModel.create({...seat, _id: undefined}).then(
      () => null,
      (error: {code?: number}) => error,
    )
    expect(duplicate?.code).toBe(11000)
  })

  test("a quantity lowered below the seats in use frees no seat and refuses new ones", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
    for (const membershipId of [ws.ownerMembershipId, ws.adminMembershipId, ws.developerMembershipId]) {
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
    }

    expect(await store().putLicense({...license, revision: 2, quantity: 1})).toEqual({applied: true, revision: 2})
    expect(await seatsOf(license.licenseId)).toHaveLength(3)
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 1, seatsUsed: 3})

    const over = await call("PUT", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.admin)
    expect(over).toMatchObject({status: 409, json: {error: "no_seats_available", error_description: "every license is assigned"}})

    // Freeing one still leaves more seats in use than the license has.
    await releaseSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.developerMembershipId)
    expect(
      (await refusal(assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId))).code,
    ).toBe("no_seats_available")
    // Down to none in use, the one seat can be given.
    expect(
      (await call("DELETE", seatPath(ws.workspaceId, license.licenseId, ws.ownerMembershipId), ws.admin)).status,
    ).toBe(204)
    expect(
      (await call("DELETE", seatPath(ws.workspaceId, license.licenseId, ws.adminMembershipId), ws.admin)).status,
    ).toBe(204)
    expect(
      (await call("PUT", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.admin)).status,
    ).toBe(200)
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 1, seatsUsed: 1})
  })

  test("removing a member, a member leaving and deleting their account free their seats; each is reusable at once", async () => {
    const ws = await newWorkspace()
    const leaver = await person("leaver")
    const deleted = await person("deleted")
    const leaverMembershipId = await addMember(ws.workspaceId, leaver, "member")
    const deletedMembershipId = await addMember(ws.workspaceId, deleted, "member")
    const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
    for (const membershipId of [ws.memberMembershipId, leaverMembershipId, deletedMembershipId]) {
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
    }
    const [spare1, spare2, spare3] = await addMembers(ws.workspaceId, 3)
    const freeOne = async (spare: string) => {
      expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(2)
      // The freed seat is the cap's again at once.
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, spare)
      expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(3)
    }

    await removeMember(actorOf(ws.owner), ws.workspaceId, ws.memberMembershipId, await revisionOf(ws.workspaceId))
    await freeOne(spare1!)
    await leaveWorkspace(actorOf(leaver), ws.workspaceId)
    await freeOne(spare2!)
    await markAccountDeleted(deleted.mentraUserId)
    await removeDeletedUserFromWorkspaces(deleted.mentraUserId)
    await freeOne(spare3!)

    expect((await seatsOf(license.licenseId)).map((seat) => seat.membershipId).sort()).toEqual(
      [spare1, spare2, spare3].sort(),
    )
    const released = await audit("seat.released")
    expect(released.map((event) => [event.target?.membershipId, event.after?.reason])).toEqual([
      [ws.memberMembershipId, "member_removed"],
      [leaverMembershipId, "member_left"],
      [deletedMembershipId, "account_deleted"],
    ])
  })

  test("a membership's seats are freed inside the transaction that ends it: an aborted removal keeps the seat", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId)
    const membership = (await WorkspaceMembershipModel.findOne({
      membershipId: ws.memberMembershipId,
    }).lean<MembershipRow>())!

    const aborted = withTransaction(async (session) => {
      const workspace = await bumpRevision(session, ws.workspaceId, undefined)
      await endMembership(session, {
        workspace,
        actor: actorOf(ws.owner),
        membership,
        reason: "removed",
        action: "membership.removed",
      })
      // Inside the transaction the seat is already gone...
      expect(await LicenseSeatModel.countDocuments({licenseId: license.licenseId}).session(session)).toBe(0)
      throw new Error("abort after ending the membership")
    })
    await expect(aborted).rejects.toThrow("abort after ending the membership")

    // ...and with the transaction aborted, nothing happened.
    expect((await WorkspaceMembershipModel.findOne({membershipId: ws.memberMembershipId}).lean())!.status).toBe(
      "active",
    )
    expect(await seatsOf(license.licenseId)).toHaveLength(1)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(1)
    expect(await audit("seat.released")).toEqual([])
  })

  test("rejoining brings no seat back: the seat belonged to the membership that ended", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId)
    await removeMember(actorOf(ws.owner), ws.workspaceId, ws.memberMembershipId, await revisionOf(ws.workspaceId))

    await addMember(ws.workspaceId, ws.member, "member")

    expect(await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, ws.member)).toEqual({
      status: 200,
      json: {items: []},
    })
    expect(await seatsOf(license.licenseId)).toEqual([])
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(0)
  })

  test("an assignment racing its member's removal never leaves a seat behind the ended membership", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 50})
    for (let round = 0; round < 5; round++) {
      const [membershipId] = await addMembers(ws.workspaceId, 1)
      await Promise.allSettled([
        assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId!),
        removeMember(actorOf(ws.owner), ws.workspaceId, membershipId!, await revisionOf(ws.workspaceId)),
      ])
    }
    const seats = await seatsOf(license.licenseId)
    const active = await WorkspaceMembershipModel.find({
      membershipId: {$in: seats.map((seat) => seat.membershipId)},
      status: "active",
    }).lean()
    expect(active).toHaveLength(seats.length)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(seats.length)
  })

  test("a seat names a membership of the license's own workspace", async () => {
    const ws = await newWorkspace()
    const elsewhere = await newWorkspace("Elsewhere")
    const license = await workspaceLicense(ws.workspaceId)
    const theirs = await workspaceLicense(elsewhere.workspaceId)
    const pending = `wm_pending_${counter++}`
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: pending,
        workspaceId: ws.workspaceId,
        pendingWorkosUserId: "legacy_1",
        role: "member",
        status: "active",
        startedAt: new Date(),
      }),
    )

    const as = (licenseId: string, membershipId: string) =>
      call("PUT", seatPath(ws.workspaceId, licenseId, membershipId), ws.admin)
    expect(await as(theirs.licenseId, ws.memberMembershipId)).toMatchObject({
      status: 404,
      json: {error: "license_not_found"},
    })
    expect(await as(newLicenseId(), ws.memberMembershipId)).toMatchObject({
      status: 404,
      json: {error: "license_not_found"},
    })
    expect(await as(license.licenseId, elsewhere.memberMembershipId)).toMatchObject({
      status: 404,
      json: {error: "not_found"},
    })
    // A membership still waiting for its person has nobody to hold a seat.
    expect(await as(license.licenseId, pending)).toMatchObject({
      status: 400,
      json: {
        error: "invalid_request",
        error_description: "this membership waits for its person's first sign-in and cannot hold a license yet",
      },
    })
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)
  })
})

// --- Several seats at once -------------------------------------------------

describe("assigning several seats at once", () => {
  type Pair = {licenseId: string; membershipId: string}
  const pair = (licenseId: string, membershipId: string): Pair => ({licenseId, membershipId})
  const assignAll = (as: Person | string | undefined, workspaceId: string, assignments: unknown) =>
    call("POST", seatAssignmentsPath(workspaceId), as, {assignments})
  const holders = async (licenseId: string) => (await seatsOf(licenseId)).map((seat) => seat.membershipId).sort()
  const byLicenseId = <T extends {licenseId: string}>(items: T[]) =>
    [...items].sort((a, b) => a.licenseId.localeCompare(b.licenseId))
  const codeOf = (error: unknown) => (error instanceof WorkspaceError ? error.code : String(error))
  /** Resolves after `ms`, so a racing write can land at different points of the requests it races. */
  const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /**
   * The feed came through the race whole: every stored `seq` runs from 1 to the counter's, each exactly once,
   * and a poller paging the feed reads the same numbers.
   */
  async function expectWholeFeed() {
    const counter = (await WorkspaceAuditCounterModel.findById(WORKSPACE_AUDIT_COUNTER_ID).lean())!.seq
    const everyNumber = Array.from({length: counter}, (_, n) => n + 1)
    const stored = await WorkspaceAuditEventModel.find({seq: {$exists: true}})
      .select({_id: 0, seq: 1})
      .lean()
    expect(stored.map((event) => event.seq).sort((a, b) => a! - b!)).toEqual(everyNumber)
    expect((await feed()).map((event) => Number(event.seq))).toEqual(everyNumber)
  }

  test("three pairs over two licenses with room are all assigned, each seat its own seat.assigned", async () => {
    const ws = await newWorkspace()
    const calls = await workspaceLicense(ws.workspaceId, {quantity: 3})
    const fleetSeats = await workspaceLicense(ws.workspaceId, {quantity: 2, product: "mentra.fleet"})
    const untouched = await workspaceLicense(ws.workspaceId, {quantity: 2, product: "mentra.other"})
    await assignSeat(actorOf(ws.owner), ws.workspaceId, calls.licenseId, ws.ownerMembershipId)

    const answer = await assignAll(ws.admin, ws.workspaceId, [
      pair(calls.licenseId, ws.memberMembershipId),
      pair(calls.licenseId, ws.developerMembershipId),
      pair(fleetSeats.licenseId, ws.memberMembershipId),
    ])

    expect(answer.status).toBe(200)
    // Every license the request named, as Core now holds it, with every seat; the one it did not name is not there.
    const answered = byLicenseId(answer.json.licenses as LicenseView[]).map((license) => ({
      ...license,
      seats: (license.seats ?? []).map((seat) => seat.membershipId).sort(),
    }))
    expect(answered).toEqual(
      byLicenseId([
        {
          ...viewOf(calls, {seatsUsed: 3}),
          seats: [ws.ownerMembershipId, ws.memberMembershipId, ws.developerMembershipId].sort(),
        },
        {...viewOf(fleetSeats, {seatsUsed: 1}), seats: [ws.memberMembershipId]},
      ]),
    )
    expect((await licenseRow(calls.licenseId))!.seatsUsed).toBe(3)
    expect((await licenseRow(fleetSeats.licenseId))!.seatsUsed).toBe(1)
    expect((await licenseRow(untouched.licenseId))!.seatsUsed).toBe(0)
    expect(await holders(calls.licenseId)).toEqual(
      [ws.ownerMembershipId, ws.memberMembershipId, ws.developerMembershipId].sort(),
    )
    expect(await holders(fleetSeats.licenseId)).toEqual([ws.memberMembershipId])

    // One event per seat after the single assignment's, each counting the seats in use once that seat was given.
    const admin = {kind: "user" as const, mentraUserId: ws.admin.mentraUserId, email: ws.admin.email}
    const target = (licenseId: string, holder: Person, membershipId: string) => ({
      licenseId,
      membershipId,
      mentraUserId: holder.mentraUserId,
      email: holder.email,
    })
    const assigned = (await audit("seat.assigned")).slice(1)
    expect(
      assigned.map((event) => ({
        workspaceId: event.workspaceId,
        actor: event.actor,
        target: event.target,
        seatsUsed: event.after?.seatsUsed,
        quantity: event.after?.quantity,
      })),
    ).toEqual([
      {
        workspaceId: ws.workspaceId,
        actor: admin,
        target: target(calls.licenseId, ws.member, ws.memberMembershipId),
        seatsUsed: 2,
        quantity: 3,
      },
      {
        workspaceId: ws.workspaceId,
        actor: admin,
        target: target(calls.licenseId, ws.developer, ws.developerMembershipId),
        seatsUsed: 3,
        quantity: 3,
      },
      {
        workspaceId: ws.workspaceId,
        actor: admin,
        target: target(fleetSeats.licenseId, ws.member, ws.memberMembershipId),
        seatsUsed: 1,
        quantity: 2,
      },
    ])
  })

  test("a license short by one is 409 no_seats_available naming it, and nothing is assigned or recorded", async () => {
    const ws = await newWorkspace()
    const roomy = await workspaceLicense(ws.workspaceId, {quantity: 5})
    const tight = await workspaceLicense(ws.workspaceId, {quantity: 3, product: "mentra.fleet"})
    await assignSeat(actorOf(ws.admin), ws.workspaceId, tight.licenseId, ws.ownerMembershipId)
    const [a, b, c] = (await addMembers(ws.workspaceId, 3)) as [string, string, string]
    const events = await WorkspaceAuditEventModel.countDocuments({})

    const refused = await assignAll(ws.admin, ws.workspaceId, [
      pair(roomy.licenseId, ws.memberMembershipId),
      pair(tight.licenseId, a),
      pair(tight.licenseId, b),
      pair(tight.licenseId, c),
    ])

    expect(refused).toEqual({
      status: 409,
      json: {
        error: "no_seats_available",
        error_description: "too few licenses are available for these assignments; nothing was assigned",
        licenses: [{licenseId: tight.licenseId, needed: 3, free: 2}],
      },
    })
    // Neither license changed: not the short one, and not the one that had room.
    expect((await licenseRow(roomy.licenseId))!.seatsUsed).toBe(0)
    expect((await licenseRow(tight.licenseId))!.seatsUsed).toBe(1)
    expect(await holders(roomy.licenseId)).toEqual([])
    expect(await holders(tight.licenseId)).toEqual([ws.ownerMembershipId])
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)

    // Every license that falls short is listed, in the order the request first names it. One whose quantity was
    // lowered below its seats in use has none free.
    await store().putLicense({...tight, revision: 2, quantity: 0})
    const both = await assignAll(ws.admin, ws.workspaceId, [
      ...[a, b, c, ws.memberMembershipId, ws.developerMembershipId, ws.adminMembershipId].map((membershipId) =>
        pair(roomy.licenseId, membershipId),
      ),
      pair(tight.licenseId, a),
    ])
    expect(both).toEqual({
      status: 409,
      json: {
        error: "no_seats_available",
        error_description: "too few licenses are available for these assignments; nothing was assigned",
        licenses: [
          {licenseId: roomy.licenseId, needed: 6, free: 5},
          {licenseId: tight.licenseId, needed: 1, free: 0},
        ],
      },
    })
    expect((await licenseRow(roomy.licenseId))!.seatsUsed).toBe(0)
    expect(await audit("seat.assigned")).toHaveLength(1)
  })

  test("two requests that each need 2 of the last 3 seats: exactly one is assigned whole, the other nothing", async () => {
    const ws = await newWorkspace()
    for (let round = 0; round < 5; round++) {
      const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
      const [a, b, c, d] = (await addMembers(ws.workspaceId, 4)) as [string, string, string, string]
      const requests = [
        [a, b],
        [c, d],
      ]

      const results = await Promise.allSettled([
        assignSeats(actorOf(ws.admin), ws.workspaceId, [pair(license.licenseId, a), pair(license.licenseId, b)]),
        assignSeats(actorOf(ws.owner), ws.workspaceId, [pair(license.licenseId, c), pair(license.licenseId, d)]),
      ])

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
      const loser = results.findIndex((result) => result.status === "rejected")
      const error = (results[loser] as PromiseRejectedResult).reason as WorkspaceError
      expect({code: codeOf(error), details: error.details}).toEqual({
        code: "no_seats_available",
        details: {licenses: [{licenseId: license.licenseId, needed: 2, free: 1}]},
      })
      expect(await holders(license.licenseId)).toEqual([...requests[1 - loser]!].sort())
      expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 3, seatsUsed: 2})
    }
    expect(await audit("seat.assigned")).toHaveLength(10)
  })

  test("bulk and single assignments racing for one license never oversell it, and a bulk one is whole or nothing", async () => {
    const ws = await newWorkspace()
    for (let round = 0; round < 3; round++) {
      const license = await workspaceLicense(ws.workspaceId, {quantity: 5})
      const bulk: string[][] = []
      for (let i = 0; i < 6; i++) bulk.push(await addMembers(ws.workspaceId, 2))
      const single = await addMembers(ws.workspaceId, 6)

      const results = await Promise.allSettled([
        ...bulk.map((ids) =>
          assignSeats(
            actorOf(ws.admin),
            ws.workspaceId,
            ids.map((membershipId) => pair(license.licenseId, membershipId)),
          ),
        ),
        ...single.map((membershipId) => assignSeat(actorOf(ws.owner), ws.workspaceId, license.licenseId, membershipId)),
      ])

      // Every refusal is the cap's: a conflict between the requests is retried, never refused.
      const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      expect(refusals.map(codeOf)).toEqual(Array(refusals.length).fill("no_seats_available"))
      const held = new Set(await holders(license.licenseId))
      // A bulk request that succeeded holds both its seats; one that was refused holds none.
      bulk.forEach((ids, at) => {
        expect({at, held: ids.filter((id) => held.has(id)).length}).toEqual({
          at,
          held: results[at]!.status === "fulfilled" ? 2 : 0,
        })
      })
      single.forEach((id, at) => {
        expect({id, held: held.has(id)}).toEqual({id, held: results[bulk.length + at]!.status === "fulfilled"})
      })
      // The singles alone could fill it, so it ends full, and never past full.
      expect(held.size).toBe(5)
      expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 5, seatsUsed: 5})
    }
    expect(await audit("seat.assigned")).toHaveLength(15)
    await expectWholeFeed()
  })

  test("releases racing bulk requests for a full license: never past its quantity, and its count is always its seats", async () => {
    const ws = await newWorkspace()
    for (let round = 0; round < 4; round++) {
      const quantity = 4
      const license = await workspaceLicense(ws.workspaceId, {quantity})
      const seated = await addMembers(ws.workspaceId, quantity)
      for (const membershipId of seated) {
        await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
      }
      // The license is full. Two of its seats are released while four requests ask for one or two each.
      const freed = seated.slice(0, 2)
      const bulk: string[][] = []
      for (let i = 0; i < 4; i++) bulk.push(await addMembers(ws.workspaceId, i % 2 === 0 ? 1 : 2))

      const [releases, results] = await Promise.all([
        Promise.allSettled(
          freed.map((membershipId, at) =>
            after(round * 3 + at * 2).then(() =>
              releaseSeat(actorOf(ws.owner), ws.workspaceId, license.licenseId, membershipId),
            ),
          ),
        ),
        Promise.allSettled(
          bulk.map((ids) =>
            assignSeats(
              actorOf(ws.admin),
              ws.workspaceId,
              ids.map((membershipId) => pair(license.licenseId, membershipId)),
            ),
          ),
        ),
      ])

      expect(releases).toEqual([
        {status: "fulfilled", value: {released: true}},
        {status: "fulfilled", value: {released: true}},
      ])
      const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      expect(refusals.map(codeOf)).toEqual(Array(refusals.length).fill("no_seats_available"))
      const held = new Set(await holders(license.licenseId))
      for (const membershipId of freed) expect(held.has(membershipId)).toBe(false)
      bulk.forEach((ids, at) => {
        expect({round, at, held: ids.filter((id) => held.has(id)).length}).toEqual({
          round,
          at,
          held: results[at]!.status === "fulfilled" ? ids.length : 0,
        })
      })
      // The count is the seats there are, within the quantity.
      expect(held.size).toBeLessThanOrEqual(quantity)
      expect(await licenseRow(license.licenseId)).toMatchObject({quantity, seatsUsed: held.size})
      // Replayed in commit order (the feed's `seq`), the seats in use never pass the quantity, and every
      // assignment counted exactly the seats there were once it was given.
      const events = await WorkspaceAuditEventModel.find({"target.licenseId": license.licenseId}).sort({seq: 1}).lean()
      let inUse = 0
      for (const event of events) {
        if (event.action === "seat.released") inUse -= 1
        if (event.action !== "seat.assigned") continue
        inUse += 1
        expect({round, inUse, seatsUsed: event.after?.seatsUsed}).toEqual({round, inUse, seatsUsed: inUse})
        expect(inUse).toBeLessThanOrEqual(quantity)
      }
      expect(inUse).toBe(held.size)
    }
    await expectWholeFeed()
  })

  test("20 one-pair requests at once for 10 free seats: exactly 10 succeed, and none is refused for a write conflict", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 10})
    const contenders = await addMembers(ws.workspaceId, 20)

    const results = await Promise.allSettled(
      contenders.map((membershipId) =>
        assignSeats(actorOf(ws.owner), ws.workspaceId, [pair(license.licenseId, membershipId)]),
      ),
    )

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10)
    const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    expect(refusals.map(codeOf)).toEqual(Array(10).fill("no_seats_available"))
    expect(await seatsOf(license.licenseId)).toHaveLength(10)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(10)
    expect(await audit("seat.assigned")).toHaveLength(10)
  })

  test("a pair already held is skipped and takes no seat, and a repeated pair counts once", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 2})
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId)
    // One seat is free: counting the held pair or the repeat would need two or three.
    const pairs = [
      pair(license.licenseId, ws.memberMembershipId),
      pair(license.licenseId, ws.developerMembershipId),
      pair(license.licenseId, ws.developerMembershipId),
    ]

    const first = await assignAll(ws.admin, ws.workspaceId, pairs)

    expect(first.status).toBe(200)
    expect(first.json.licenses).toHaveLength(1)
    expect(first.json.licenses[0]).toMatchObject({licenseId: license.licenseId, quantity: 2, seatsUsed: 2})
    expect(await holders(license.licenseId)).toEqual([ws.memberMembershipId, ws.developerMembershipId].sort())
    expect((await audit("seat.assigned")).map((event) => event.target?.membershipId)).toEqual([
      ws.memberMembershipId,
      ws.developerMembershipId,
    ])

    // Asked again, every pair is held: nothing changes, and the answer is the same. 500 repeats of one pair too.
    expect(await assignAll(ws.admin, ws.workspaceId, pairs)).toEqual(first)
    expect(await assignAll(ws.admin, ws.workspaceId, Array(500).fill(pairs[1]))).toEqual(first)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(2)
    expect(await audit("seat.assigned")).toHaveLength(2)
  })

  test("each pair is checked as a single assignment is, and one refused pair assigns nothing", async () => {
    const ws = await newWorkspace()
    const elsewhere = await newWorkspace("Elsewhere")
    const license = await workspaceLicense(ws.workspaceId)
    const theirs = await workspaceLicense(elsewhere.workspaceId)
    const ended = await workspaceLicense(ws.workspaceId, {product: "mentra.fleet"})
    await LicenseModel.updateOne(
      {_id: ended.licenseId},
      {$set: {endedAt: new Date(), endedReason: "workspace_deleted"}},
    )
    const pending = `wm_pending_${counter++}`
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: pending,
        workspaceId: ws.workspaceId,
        pendingWorkosUserId: "legacy_1",
        role: "member",
        status: "active",
        startedAt: new Date(),
      }),
    )
    const fits = pair(license.licenseId, ws.memberMembershipId)

    const cases: Array<{refused: Pair; status: number; error: string}> = [
      // A member who has not signed in yet has nobody to hold a seat.
      {refused: pair(license.licenseId, pending), status: 400, error: "invalid_request"},
      {refused: pair(theirs.licenseId, ws.developerMembershipId), status: 404, error: "license_not_found"},
      {refused: pair(newLicenseId(), ws.developerMembershipId), status: 404, error: "license_not_found"},
      {refused: pair(ended.licenseId, ws.developerMembershipId), status: 409, error: "license_ended"},
      {refused: pair(license.licenseId, elsewhere.memberMembershipId), status: 404, error: "not_found"},
    ]
    for (const {refused, status, error} of cases) {
      // Before or after a pair that would fit, the request assigns nothing.
      for (const assignments of [
        [fits, refused],
        [refused, fits],
      ]) {
        const answer = await assignAll(ws.admin, ws.workspaceId, assignments)
        expect({assignments, status: answer.status, error: answer.json?.error}).toEqual({assignments, status, error})
      }
    }
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(0)
    expect(await audit("seat.assigned")).toEqual([])
  })

  test("an assignment racing a member's removal is whole or nothing, and leaves no seat behind the ended membership", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 50})
    for (let round = 0; round < 5; round++) {
      const [leaving, staying] = (await addMembers(ws.workspaceId, 2)) as [string, string]
      const [assigned] = await Promise.allSettled([
        assignSeats(actorOf(ws.admin), ws.workspaceId, [
          pair(license.licenseId, staying),
          pair(license.licenseId, leaving),
        ]),
        removeMember(actorOf(ws.owner), ws.workspaceId, leaving, await revisionOf(ws.workspaceId)),
      ])
      const held = await holders(license.licenseId)
      expect({round, staying: held.includes(staying), leaving: held.includes(leaving)}).toEqual({
        round,
        staying: assigned.status === "fulfilled",
        leaving: false,
      })
    }
    const seats = await seatsOf(license.licenseId)
    const active = await WorkspaceMembershipModel.find({
      membershipId: {$in: seats.map((seat) => seat.membershipId)},
      status: "active",
    }).lean()
    expect(active).toHaveLength(seats.length)
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(seats.length)
  })

  test("a quantity lowered while bulk requests are in flight: no seat is assigned past the quantity it commits under", async () => {
    const ws = await newWorkspace()
    for (let round = 0; round < 4; round++) {
      const license = await workspaceLicense(ws.workspaceId, {quantity: 10})
      const bulk: string[][] = []
      for (let i = 0; i < 4; i++) bulk.push(await addMembers(ws.workspaceId, 3))

      const [lowered, ...results] = await Promise.allSettled([
        after(round * 4).then(() => store().putLicense({...license, revision: 2, quantity: 4})),
        ...bulk.map((ids) =>
          assignSeats(
            actorOf(ws.admin),
            ws.workspaceId,
            ids.map((membershipId) => pair(license.licenseId, membershipId)),
          ),
        ),
      ])

      expect(lowered).toEqual({status: "fulfilled", value: {applied: true, revision: 2}})
      const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      expect(refusals.map(codeOf)).toEqual(Array(refusals.length).fill("no_seats_available"))
      const held = new Set(await holders(license.licenseId))
      bulk.forEach((ids, at) => {
        expect({round, at, held: ids.filter((id) => held.has(id)).length}).toEqual({
          round,
          at,
          held: results[at]!.status === "fulfilled" ? 3 : 0,
        })
      })
      // Replayed in commit order (the feed's `seq`), every seat was given within the quantity in force when its
      // request committed, and saw that quantity: the lowering and the assignments never interleave.
      const events = await WorkspaceAuditEventModel.find({"target.licenseId": license.licenseId}).sort({seq: 1}).lean()
      let quantity = 0
      let inUse = 0
      for (const event of events) {
        if (event.action === "license.written") quantity = event.after?.quantity
        if (event.action !== "seat.assigned") continue
        inUse += 1
        expect({round, inUse, quantity, seen: event.after?.quantity, seatsUsed: event.after?.seatsUsed}).toEqual({
          round,
          inUse,
          quantity,
          seen: quantity,
          seatsUsed: inUse,
        })
        expect(inUse).toBeLessThanOrEqual(quantity)
      }
      expect(inUse).toBe(held.size)
      expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 4, seatsUsed: held.size})
    }
  })

  test("a license that ends while bulk requests are in flight keeps no seat, and none is assigned after it ends", async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await newWorkspace(`Ending ${round}`)
      const license = await workspaceLicense(ws.workspaceId, {quantity: 10})
      const bulk: string[][] = []
      for (let i = 0; i < 4; i++) bulk.push(await addMembers(ws.workspaceId, 2))

      const [deleted, ...results] = await Promise.allSettled([
        after(round * 4).then(() => deleteWorkspace(actorOf(ws.owner), ws.workspaceId, {confirmName: ws.name})),
        ...bulk.map((ids) =>
          assignSeats(
            actorOf(ws.admin),
            ws.workspaceId,
            ids.map((membershipId) => pair(license.licenseId, membershipId)),
          ),
        ),
      ])

      expect(deleted.status).toBe("fulfilled")
      // A request that lost the race finds the workspace, and its license, gone.
      const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      expect(refusals.map(codeOf)).toEqual(Array(refusals.length).fill("workspace_deleted"))
      expect(await seatsOf(license.licenseId)).toEqual([])
      expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 0, endedReason: "workspace_deleted"})
      // Every seat a request gave before the end, the end released; none was given after it.
      const events = await WorkspaceAuditEventModel.find({"target.licenseId": license.licenseId}).sort({seq: 1}).lean()
      const assigned = events.filter((event) => event.action === "seat.assigned")
      const ended = events.filter((event) => event.action === "license.ended")
      expect(assigned).toHaveLength(2 * results.filter((result) => result.status === "fulfilled").length)
      expect(ended).toHaveLength(1)
      expect(ended[0]!.after?.releasedSeats).toBe(assigned.length)
      for (const event of assigned) expect(event.seq!).toBeLessThan(ended[0]!.seq!)
    }
  })

  test("a 500-pair request takes the feed counter once, and records its 500 events in a row, in pair order", async () => {
    const ws = await newWorkspace()
    const calls = await workspaceLicense(ws.workspaceId, {quantity: 251})
    const fleetSeats = await workspaceLicense(ws.workspaceId, {quantity: 250, product: "mentra.fleet"})
    const members = await addMembers(ws.workspaceId, 250)
    // Interleaved: the events come grouped by license, in the order the pairs first name each.
    const pairs = members.flatMap((membershipId) => [
      pair(calls.licenseId, membershipId),
      pair(fleetSeats.licenseId, membershipId),
    ])
    expect(pairs).toHaveLength(500)

    // What a request does, in order, to the licenses, the seats and the feed. The originals are taken before
    // the spies replace them.
    const steps: string[] = []
    const logged =
      (step: string, original: (...args: any[]) => unknown) =>
      (...args: any[]) => {
        steps.push(step)
        return original(...args)
      }
    const originals = {
      counter: WorkspaceAuditCounterModel.findOneAndUpdate.bind(WorkspaceAuditCounterModel),
      events: WorkspaceAuditEventModel.insertMany.bind(WorkspaceAuditEventModel),
      licenses: LicenseModel.find.bind(LicenseModel),
      seats: LicenseSeatModel.find.bind(LicenseSeatModel),
    }
    const spies = [
      spyOn(WorkspaceAuditCounterModel, "findOneAndUpdate").mockImplementation(
        logged("counter", originals.counter) as never,
      ),
      spyOn(WorkspaceAuditEventModel, "insertMany").mockImplementation(logged("events", originals.events) as never),
      spyOn(LicenseModel, "find").mockImplementation(logged("read licenses", originals.licenses) as never),
      spyOn(LicenseSeatModel, "find").mockImplementation(logged("read seats", originals.seats) as never),
    ]
    try {
      await assignSeats(actorOf(ws.admin), ws.workspaceId, pairs)
      expect(steps.filter((step) => step === "counter")).toHaveLength(1)
      // The feed counter is taken by the transaction's last two writes, with nothing read after it: the answer's
      // licenses and seats are read before.
      expect(steps.slice(-2)).toEqual(["counter", "events"])
      expect(steps.slice(0, -2)).toEqual(expect.arrayContaining(["read licenses", "read seats"]))
      // A single seat takes the counter as often, and as late.
      steps.length = 0
      await assignSeat(actorOf(ws.admin), ws.workspaceId, calls.licenseId, ws.memberMembershipId)
      expect(steps.filter((step) => step === "counter")).toHaveLength(1)
      expect(steps.slice(-2)).toEqual(["counter", "events"])
      expect(steps.slice(0, -2)).toEqual(expect.arrayContaining(["read licenses", "read seats"]))
    } finally {
      for (const spy of spies) spy.mockRestore()
    }

    const events = (await WorkspaceAuditEventModel.find({action: "seat.assigned"}).sort({seq: 1}).lean()).slice(0, 500)
    const first = events[0]!.seq!
    expect(events.map((event) => event.seq)).toEqual(Array.from({length: 500}, (_, n) => first + n))
    expect(events.map((event) => [event.target?.licenseId, event.target?.membershipId])).toEqual([
      ...members.map((membershipId) => [calls.licenseId, membershipId]),
      ...members.map((membershipId) => [fleetSeats.licenseId, membershipId]),
    ])
    const counted = Array.from({length: 250}, (_, n) => n + 1)
    expect(events.map((event) => event.after?.seatsUsed)).toEqual([...counted, ...counted])
    const eventIds = events.map((event) => event.eventId)
    expect([...eventIds].sort()).toEqual(eventIds)
    expect((await licenseRow(calls.licenseId))!.seatsUsed).toBe(251)
    expect((await licenseRow(fleetSeats.licenseId))!.seatsUsed).toBe(250)
  })

  test("only people who assign seats may: Developers, Members, strangers and keys get 403; 0 or 501 pairs are 400", async () => {
    const ws = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
    const license = await workspaceLicense(ws.workspaceId)
    const {token: workspaceKey} = await createWorkspaceCredential(actorOf(ws.owner), ws.workspaceId, {name: "CI"})
    const fits = [pair(license.licenseId, ws.memberMembershipId)]

    for (const who of [ws.developer, ws.member, ws.stranger, workspaceKey]) {
      expect((await assignAll(who, ws.workspaceId, fits)).status).toBe(403)
    }
    // The service refuses a person who doesn't assign licenses in its own words, whoever the route let through.
    const notAdmin = await refusal(assignSeat(actorOf(ws.developer), ws.workspaceId, license.licenseId, ws.memberMembershipId))
    expect([notAdmin.code, notAdmin.message]).toEqual(["forbidden", "assigning licenses requires the admin role"])
    // Without a bearer, the portal's route group reads its cookie, so a request from elsewhere is refused before
    // sign-in is asked for; the bearer-only group asks for sign-in.
    expect((await assignAll(undefined, ws.workspaceId, fits)).status).toBe(403)
    const anonymous = await call("POST", `/api/workspaces/${ws.workspaceId}/seat-assignments`, undefined, {
      assignments: fits,
    })
    expect(anonymous.status).toBe(401)
    for (const assignments of [[], Array(501).fill(fits[0]), "nope", [{licenseId: license.licenseId}]]) {
      expect(await assignAll(ws.admin, ws.workspaceId, assignments)).toMatchObject({
        status: 400,
        json: {error: "invalid_request"},
      })
    }
    expect((await call("POST", seatAssignmentsPath(ws.workspaceId), ws.admin, {})).status).toBe(400)
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)

    // Organization Admins act as Owner. The route is under each route group the workspace handlers are.
    expect((await assignAll(orgAdmin, ws.workspaceId, fits)).status).toBe(200)
    const viaApi = await call("POST", `/api/workspaces/${ws.workspaceId}/seat-assignments`, ws.owner, {
      assignments: [pair(license.licenseId, ws.developerMembershipId)],
    })
    expect(viaApi.status).toBe(200)
    expect(await holders(license.licenseId)).toEqual([ws.memberMembershipId, ws.developerMembershipId].sort())
  })
})

// --- Recording many events at once -----------------------------------------

describe("recording many events at once", () => {
  test("a batch stores the events one write each would, in order, with contiguous seq, and the feed serves them so", async () => {
    const inputs = (action: string): WorkspaceAuditEventInput[] =>
      [1, 2, 3].map((n) => ({
        workspaceId: "ws_batch",
        action,
        actor: {kind: "system" as const},
        target: {n},
        before: null,
        after: {n},
      }))
    await withTransaction(async (session) => {
      for (const input of inputs("test.one_by_one")) await recordWorkspaceEvent(session, input)
    })
    const eventIds = await withTransaction((session) => recordWorkspaceEvents(session, inputs("test.batch")))

    const read = async (action: string) =>
      (await WorkspaceAuditEventModel.find({action}).sort({seq: 1}).lean()) as unknown as Array<Record<string, unknown>>
    const oneByOne = await read("test.one_by_one")
    const batch = await read("test.batch")
    const comparable = ({
      _id,
      eventId,
      seq,
      occurredAt,
      createdAt,
      updatedAt,
      action,
      ...rest
    }: Record<string, unknown>) => rest
    expect(batch.map(comparable)).toEqual(oneByOne.map(comparable))
    expect(batch.map((event) => event.eventId)).toEqual(eventIds)
    const both = [...oneByOne, ...batch]
    const first = both[0]!.seq as number
    expect(both.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5].map((n) => first + n))
    const ids = both.map((event) => event.eventId as string)
    expect([...ids].sort()).toEqual(ids)
    for (const event of batch) expect(event.occurredAt).toBeInstanceOf(Date)
    expect(
      (await feed()).filter((event) => event.workspaceId === "ws_batch").map((event) => [event.action, event.target]),
    ).toEqual([...[1, 2, 3].map((n) => ["test.one_by_one", {n}]), ...[1, 2, 3].map((n) => ["test.batch", {n}])])

    // An empty batch records nothing and takes no number.
    const counter = async () => (await WorkspaceAuditCounterModel.findById(WORKSPACE_AUDIT_COUNTER_ID).lean())!.seq
    const before = await counter()
    expect(await withTransaction((session) => recordWorkspaceEvents(session, []))).toEqual([])
    expect(await counter()).toBe(before)
  })

  test("an aborted batch rolls its numbers back with its events, so the feed has no gap", async () => {
    const input: WorkspaceAuditEventInput = {
      workspaceId: "ws_batch",
      action: "test.aborted",
      actor: {kind: "system"},
      target: null,
      before: null,
      after: null,
    }
    await withTransaction((session) => recordWorkspaceEvent(session, {...input, action: "test.kept"}))
    const aborted = withTransaction(async (session) => {
      await recordWorkspaceEvents(session, [input, input, input])
      throw new Error("abort after the batch")
    })
    await expect(aborted).rejects.toThrow("abort after the batch")
    await withTransaction((session) => recordWorkspaceEvents(session, [{...input, action: "test.next"}]))

    expect(await WorkspaceAuditEventModel.countDocuments({action: "test.aborted"})).toBe(0)
    const kept = (await WorkspaceAuditEventModel.findOne({action: "test.kept"}).lean())!
    const next = (await WorkspaceAuditEventModel.findOne({action: "test.next"}).lean())!
    expect(next.seq).toBe(kept.seq! + 1)
  })
})

// --- Ending with the owner -------------------------------------------------

describe("ending with the owner", () => {
  test("deleting a workspace ends its licenses and frees their seats, and Core refuses further writes for it", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
    const untouched = await workspaceLicense((await newWorkspace("Other")).workspaceId)
    for (const membershipId of [ws.memberMembershipId, ws.developerMembershipId]) {
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
    }

    await deleteWorkspace(actorOf(ws.owner), ws.workspaceId, {confirmName: ws.name})

    const ended = (await licenseRow(license.licenseId))!
    expect(ended).toMatchObject({endedReason: "workspace_deleted", seatsUsed: 0})
    expect(ended.endedAt).toBeInstanceOf(Date)
    expect(await seatsOf(license.licenseId)).toEqual([])
    expect((await licenseRow(untouched.licenseId))!.endedAt).toBeNull()
    expect(await store().listLicenses(ws.workspaceId)).toEqual({
      licenses: [viewOf(license, {seatsUsed: 0, endedAt: ended.endedAt!.toISOString()})],
    })
    await expectClientError(store().putLicense({...license, revision: 2}), "owner_not_found", 404)

    // On the feed: the seats, then the license, then the workspace.
    const events = (await feed()).filter((event) => event.workspaceId === ws.workspaceId).map((event) => event.action)
    expect(events.slice(-4)).toEqual(["seat.released", "seat.released", "license.ended", "workspace.deleted"])
    expect((await audit("seat.released")).map((event) => event.after?.reason)).toEqual([
      "workspace_deleted",
      "workspace_deleted",
    ])
    expect((await audit("license.ended"))[0]).toMatchObject({
      workspaceId: ws.workspaceId,
      target: {licenseId: license.licenseId},
      after: {reason: "workspace_deleted"},
    })
  })

  test("deleting an account frees the person's seats with their memberships, and ends no license", async () => {
    const ws = await newWorkspace()
    const elsewhere = await newWorkspace("Elsewhere")
    const elsewhereMembershipId = await addMember(elsewhere.workspaceId, ws.member, "member")
    const license = await workspaceLicense(ws.workspaceId, {quantity: 3})
    const theirs = await workspaceLicense(elsewhere.workspaceId, {quantity: 2})
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.developerMembershipId)
    await assignSeat(actorOf(elsewhere.admin), elsewhere.workspaceId, theirs.licenseId, elsewhereMembershipId)

    await markAccountDeleted(ws.member.mentraUserId)
    await removeDeletedUserFromWorkspaces(ws.member.mentraUserId)

    // Each seat went with its membership; the licenses stand, and take writes as before.
    expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 1, endedAt: null, endedReason: null})
    expect(await licenseRow(theirs.licenseId)).toMatchObject({seatsUsed: 0, endedAt: null, endedReason: null})
    expect((await seatsOf(license.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.developerMembershipId])
    expect(await seatsOf(theirs.licenseId)).toEqual([])
    expect(await store().putLicense({...license, revision: 2})).toEqual({applied: true, revision: 2})
    expect(await audit("license.ended")).toEqual([])
    expect(
      (await audit("seat.released")).map((event) => [event.target?.membershipId, event.after?.reason]).sort(),
    ).toEqual(
      [
        [ws.memberMembershipId, "account_deleted"],
        [elsewhereMembershipId, "account_deleted"],
      ].sort(),
    )
    // On the feed, each release comes before the tombstone.
    const actions = (await feed()).map((event) => event.action)
    expect(actions.lastIndexOf("seat.released")).toBeLessThan(actions.indexOf("user.deleted"))

    // Running the deletion again frees and ends nothing more.
    await removeDeletedUserFromWorkspaces(ws.member.mentraUserId)
    expect(await audit("seat.released")).toHaveLength(2)
    expect(await audit("license.ended")).toEqual([])
  })
})

// --- The workspace licenses routes -------------------------------------------

describe("the workspace licenses routes", () => {
  test("members see only their own seats; Admins, Owners and Organization Admins see every license and seat", async () => {
    const ws = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
    const calls = await workspaceLicense(ws.workspaceId, {quantity: 5})
    const fleetSeats = await workspaceLicense(ws.workspaceId, {quantity: 2, product: "mentra.fleet"})
    await assignSeat(actorOf(ws.admin), ws.workspaceId, calls.licenseId, ws.memberMembershipId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, calls.licenseId, ws.developerMembershipId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, fleetSeats.licenseId, ws.adminMembershipId)
    const seat = async (licenseId: string, membershipId: string) => {
      const row = (await LicenseSeatModel.findOne({licenseId, membershipId}).lean())!
      return {membershipId, mentraUserId: row.mentraUserId, assignedAt: row.assignedAt.toISOString()}
    }
    const bySeat = (seats: Array<{membershipId: string}>) =>
      [...seats].sort((a, b) => a.membershipId.localeCompare(b.membershipId))
    const everything = [
      {
        ...viewOf(calls, {seatsUsed: 2}),
        seats: bySeat([
          await seat(calls.licenseId, ws.memberMembershipId),
          await seat(calls.licenseId, ws.developerMembershipId),
        ]),
      },
      {...viewOf(fleetSeats, {seatsUsed: 1}), seats: [await seat(fleetSeats.licenseId, ws.adminMembershipId)]},
    ].sort((a, b) => a.licenseId.localeCompare(b.licenseId))
    const listed = async (as: Person) => {
      const answer = await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, as)
      expect(answer.status).toBe(200)
      return (answer.json.items as LicenseView[])
        .map((license) => ({...license, seats: bySeat(license.seats ?? [])}))
        .sort((a, b) => a.licenseId.localeCompare(b.licenseId))
    }

    for (const who of [ws.owner, ws.admin, orgAdmin]) expect(await listed(who)).toEqual(everything)
    expect(await listed(ws.member)).toEqual([
      {...viewOf(calls, {seatsUsed: 2}), seats: [await seat(calls.licenseId, ws.memberMembershipId)]},
    ])
    expect(await listed(ws.developer)).toEqual([
      {...viewOf(calls, {seatsUsed: 2}), seats: [await seat(calls.licenseId, ws.developerMembershipId)]},
    ])
    expect((await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, ws.stranger)).status).toBe(403)
    expect((await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`)).status).toBe(401)
  })

  test("Admins, Owners and Organization Admins assign and unassign seats; Developers, Members and keys can't", async () => {
    const ws = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
    const license = await workspaceLicense(ws.workspaceId)
    const {token: workspaceKey} = await createWorkspaceCredential(actorOf(ws.owner), ws.workspaceId, {name: "CI"})
    const path = (membershipId: string) => seatPath(ws.workspaceId, license.licenseId, membershipId)

    for (const who of [ws.developer, ws.member, ws.stranger]) {
      expect((await call("PUT", path(ws.memberMembershipId), who)).status).toBe(403)
    }
    // Keys never manage people, not even the workspace's own.
    expect((await call("PUT", path(ws.memberMembershipId), workspaceKey)).status).toBe(403)
    expect((await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, workspaceKey)).status).toBe(403)
    expect(await seatsOf(license.licenseId)).toEqual([])

    const assigned = await call("PUT", path(ws.memberMembershipId), ws.admin)
    expect(assigned.status).toBe(200)
    expect(assigned.json).toMatchObject({licenseId: license.licenseId, seatsUsed: 1, quantity: 5})
    expect(assigned.json.seats.map((seat: {membershipId: string}) => seat.membershipId)).toEqual([
      ws.memberMembershipId,
    ])
    expect((await call("PUT", path(ws.developerMembershipId), ws.owner)).status).toBe(200)
    expect((await call("PUT", path(ws.adminMembershipId), orgAdmin)).status).toBe(200)

    for (const who of [ws.developer, ws.member]) {
      expect((await call("DELETE", path(ws.memberMembershipId), who)).status).toBe(403)
    }
    expect((await call("DELETE", path(ws.memberMembershipId), ws.admin)).status).toBe(204)
    // Unassigning a seat nobody holds changes nothing.
    expect((await call("DELETE", path(ws.memberMembershipId), ws.admin)).status).toBe(204)
    expect((await seatsOf(license.licenseId)).map((seat) => seat.membershipId).sort()).toEqual(
      [ws.adminMembershipId, ws.developerMembershipId].sort(),
    )
    expect((await licenseRow(license.licenseId))!.seatsUsed).toBe(2)
    expect((await audit("seat.released")).map((event) => event.after?.reason)).toEqual(["unassigned"])
  })
})

// --- Listing a workspace's licenses ----------------------------------------

describe("listing a workspace's licenses", () => {
  test("seats come back in assignment order, then by membership, and the query sends no sort", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 5})
    const [first, second] = [ws.developerMembershipId, ws.memberMembershipId]
    for (const membershipId of [ws.adminMembershipId, first, second, ws.ownerMembershipId]) {
      await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, membershipId)
    }
    // Assigned at times in none of the memberships' id order, two of them at the very same instant.
    const assignedAt = {
      [ws.adminMembershipId]: new Date("2026-10-03T00:00:00.000Z"),
      [first]: new Date("2026-10-01T00:00:00.000Z"),
      [second]: new Date("2026-10-02T00:00:00.000Z"),
      [ws.ownerMembershipId]: new Date("2026-10-02T00:00:00.000Z"),
    }
    for (const [membershipId, at] of Object.entries(assignedAt)) {
      await LicenseSeatModel.updateOne({licenseId: license.licenseId, membershipId}, {$set: {assignedAt: at}})
    }
    const expected = Object.entries(assignedAt)
      .sort(([idA, atA], [idB, atB]) => atA.getTime() - atB.getTime() || (idA < idB ? -1 : idA > idB ? 1 : 0))
      .map(([membershipId]) => membershipId)
    expect(expected[0]).toBe(first)
    expect(expected[3]).toBe(ws.adminMembershipId)

    // Cosmos DB's MongoDB API rejects a sort on a path with no index, so the seats' query sends none.
    const queries: Array<{getOptions(): {sort?: unknown}}> = []
    const find = LicenseSeatModel.find.bind(LicenseSeatModel)
    const spy = spyOn(LicenseSeatModel, "find").mockImplementation(((...args: unknown[]) => {
      const query = (find as (...rest: unknown[]) => {getOptions(): {sort?: unknown}})(...args)
      queries.push(query)
      return query
    }) as never)
    try {
      const everyone = await listWorkspaceLicenses(ws.workspaceId, "everyone")
      expect(everyone).toHaveLength(1)
      expect(everyone[0]!.seats!.map((seat) => seat.membershipId)).toEqual(expected)
      const own = await listWorkspaceLicenses(ws.workspaceId, second)
      expect(own[0]!.seats!.map((seat) => seat.membershipId)).toEqual([second])
    } finally {
      spy.mockRestore()
    }
    expect(queries).toHaveLength(2)
    for (const query of queries) expect(query.getOptions().sort).toBeUndefined()
  })
})

// --- Audit -----------------------------------------------------------------

describe("audit", () => {
  test("every license and seat change records its event with its actor, on the workspace's change feed", async () => {
    const ws = await newWorkspace()
    const license = await workspaceLicense(ws.workspaceId, {quantity: 2})
    await store().putLicense({...license, revision: 2, quantity: 3})
    expect(
      (await call("PUT", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.admin)).status,
    ).toBe(200)
    expect(
      (await call("DELETE", seatPath(ws.workspaceId, license.licenseId, ws.memberMembershipId), ws.owner)).status,
    ).toBe(204)

    const written = await audit("license.written")
    expect(
      written.map((event) => ({
        workspaceId: event.workspaceId,
        actor: event.actor,
        licenseId: event.target?.licenseId,
      })),
    ).toEqual([
      {workspaceId: ws.workspaceId, actor: {kind: "service", service: "store"}, licenseId: license.licenseId},
      {workspaceId: ws.workspaceId, actor: {kind: "service", service: "store"}, licenseId: license.licenseId},
    ])
    expect(written[1]).toMatchObject({before: {revision: 1, quantity: 2}, after: {revision: 2, quantity: 3}})
    const [assigned] = await audit("seat.assigned")
    expect(assigned).toMatchObject({
      workspaceId: ws.workspaceId,
      actor: {kind: "user", mentraUserId: ws.admin.mentraUserId, email: ws.admin.email},
      target: {
        licenseId: license.licenseId,
        membershipId: ws.memberMembershipId,
        mentraUserId: ws.member.mentraUserId,
        email: ws.member.email,
      },
    })
    const [released] = await audit("seat.released")
    expect(released).toMatchObject({
      workspaceId: ws.workspaceId,
      actor: {kind: "user", mentraUserId: ws.owner.mentraUserId},
      target: {licenseId: license.licenseId, membershipId: ws.memberMembershipId},
      after: {reason: "unassigned"},
    })

    // The feed carries the workspace's license and seat events in order.
    const onFeed = (await feed()).filter(
      (event) => event.action.startsWith("license.") || event.action.startsWith("seat."),
    )
    expect(onFeed.map((event) => [event.action, event.workspaceId, event.target?.licenseId])).toEqual([
      ["license.written", ws.workspaceId, license.licenseId],
      ["license.written", ws.workspaceId, license.licenseId],
      ["seat.assigned", ws.workspaceId, license.licenseId],
      ["seat.released", ws.workspaceId, license.licenseId],
    ])

    // And the workspace's own audit page shows them.
    const page = await call("GET", `/api/workspaces/${ws.workspaceId}/audit`, ws.owner)
    expect(page.json.items.map((event: {action: string}) => event.action).slice(0, 4)).toEqual([
      "seat.released",
      "seat.assigned",
      "license.written",
      "license.written",
    ])
  })
})

// --- The buyer's license ---------------------------------------------------

describe("the buyer's license", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  /** A term from `fromDays` to `toDays` days around the real clock's now, which is what "in its term" asks about. */
  const term = (fromDays: number, toDays: number) => ({
    validFrom: new Date(Date.now() + fromDays * DAY_MS).toISOString(),
    paidThrough: new Date(Date.now() + toDays * DAY_MS).toISOString(),
  })
  const inTerm = () => term(-1, 30)
  const buyer = (who: {mentraUserId: string}) => ({assignTo: {mentraUserId: who.mentraUserId}})
  const ownerOf = (workspaceId: string): LicenseOwner => ({type: "workspace", workspaceId})
  /** Every audit event of one license, in commit order. */
  const eventsOf = (licenseId: string) =>
    WorkspaceAuditEventModel.find({"target.licenseId": licenseId}).sort({seq: 1}).lean()

  test("the write that creates a license gives its buyer one, recorded after the write, by the Store", async () => {
    const ws = await newWorkspace()
    const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(ws.member)})

    expect(await store().putLicense(write)).toEqual({applied: true, revision: 1})

    expect(await store().listLicenses(ws.workspaceId)).toEqual({licenses: [viewOf(write, {seatsUsed: 1})]})
    const seats = await seatsOf(write.licenseId)
    expect(seats).toHaveLength(1)
    expect(seats[0]).toMatchObject({
      workspaceId: ws.workspaceId,
      membershipId: ws.memberMembershipId,
      mentraUserId: ws.member.mentraUserId,
      assignedBy: null,
    })
    // The member sees it as their own.
    const mine = await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, ws.member)
    expect(
      (mine.json.items as LicenseView[]).map((license) => [
        license.licenseId,
        license.seats?.map((s) => s.membershipId),
      ]),
    ).toEqual([[write.licenseId, [ws.memberMembershipId]]])

    // `license.written`, then `seat.assigned`, next to each other on the feed, both the Store's.
    const events = await eventsOf(write.licenseId)
    expect(events.map((event) => [event.action, event.actor])).toEqual([
      ["license.written", {kind: "service", service: "store"}],
      ["seat.assigned", {kind: "service", service: "store"}],
    ])
    expect(events[1]!.seq).toBe(events[0]!.seq! + 1)
    expect(events[1]).toMatchObject({
      workspaceId: ws.workspaceId,
      target: {
        licenseId: write.licenseId,
        membershipId: ws.memberMembershipId,
        mentraUserId: ws.member.mentraUserId,
        email: ws.member.email,
      },
      before: null,
      after: {seatsUsed: 1, quantity: 5},
    })
    expect((await feed()).filter((event) => event.target?.licenseId === write.licenseId).map((e) => e.action)).toEqual([
      "license.written",
      "seat.assigned",
    ])
  })

  test("a license of one gives its one license to the buyer, and no further assignment fits", async () => {
    const ws = await newWorkspace()
    const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 1, ...inTerm(), ...buyer(ws.owner)})
    await store().putLicense(write)

    expect(await licenseRow(write.licenseId)).toMatchObject({quantity: 1, seatsUsed: 1})
    expect((await seatsOf(write.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.ownerMembershipId])
    expect(
      (await refusal(assignSeat(actorOf(ws.admin), ws.workspaceId, write.licenseId, ws.memberMembershipId))).code,
    ).toBe("no_seats_available")
  })

  test("only the creating write assigns: a repeat changes nothing, and a later revision gives nothing back", async () => {
    const ws = await newWorkspace()
    const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(ws.member)})
    await store().putLicense(write)

    // Billing sends the same revision again.
    expect(await store().putLicense(write)).toEqual({applied: false, revision: 1})
    expect(await licenseRow(write.licenseId)).toMatchObject({seatsUsed: 1})
    expect(await seatsOf(write.licenseId)).toHaveLength(1)

    // An Admin unassigns the buyer; the next revision names them again and assigns nothing.
    await releaseSeat(actorOf(ws.admin), ws.workspaceId, write.licenseId, ws.memberMembershipId)
    expect(await store().putLicense({...write, revision: 2, quantity: 6})).toEqual({applied: true, revision: 2})
    expect(await licenseRow(write.licenseId)).toMatchObject({quantity: 6, seatsUsed: 0})
    expect(await seatsOf(write.licenseId)).toEqual([])
    expect((await eventsOf(write.licenseId)).map((event) => event.action)).toEqual([
      "license.written",
      "seat.assigned",
      "seat.released",
      "license.written",
    ])
  })

  test("out of order, whichever revision arrives first creates the license and assigns once", async () => {
    const ws = await newWorkspace()
    const first = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(ws.member)})
    const second = {...first, revision: 2, quantity: 3}

    expect(await store().putLicense(second)).toEqual({applied: true, revision: 2})
    await expectClientError(store().putLicense(first), "stale_revision", 409)
    expect(await store().putLicense(second)).toEqual({applied: false, revision: 2})

    expect(await licenseRow(first.licenseId)).toMatchObject({revision: 2, quantity: 3, seatsUsed: 1})
    expect((await seatsOf(first.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.memberMembershipId])
    expect(await audit("seat.assigned")).toHaveLength(1)
  })

  test("no license for someone who is not an active member: never joined, left, or an Organization Admin outside it", async () => {
    const ws = await newWorkspace()
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
    const leaver = await person("leaver")
    await addMember(ws.workspaceId, leaver, "member")
    await leaveWorkspace(actorOf(leaver), ws.workspaceId)
    // A member of another workspace is not a member of this one.
    const elsewhere = await newWorkspace("Elsewhere")

    for (const who of [ws.stranger, leaver, orgAdmin, elsewhere.member, {mentraUserId: "mu_never"}]) {
      const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(who)})
      expect(await store().putLicense(write)).toEqual({applied: true, revision: 1})
      expect(await licenseRow(write.licenseId)).toMatchObject({seatsUsed: 0})
    }
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)
    expect(await audit("seat.assigned")).toEqual([])
    expect(await audit("license.written")).toHaveLength(5)
  })

  test("no license from a write of quantity 0, and none from a write that names no one", async () => {
    const ws = await newWorkspace()
    const none = licenseWrite(ownerOf(ws.workspaceId), {quantity: 0, ...inTerm(), ...buyer(ws.member)})
    const unnamed = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm()})

    expect(await store().putLicense(none)).toEqual({applied: true, revision: 1})
    expect(await store().putLicense(unnamed)).toEqual({applied: true, revision: 1})

    expect(await licenseRow(none.licenseId)).toMatchObject({quantity: 0, seatsUsed: 0})
    expect(await licenseRow(unnamed.licenseId)).toMatchObject({quantity: 5, seatsUsed: 0})
    expect(await LicenseSeatModel.countDocuments({})).toBe(0)
    expect(await audit("seat.assigned")).toEqual([])
  })

  test("no second license of a product the buyer already holds there in its term; another product, term or workspace doesn't count", async () => {
    const ws = await newWorkspace()
    const other = await newWorkspace("Other")
    const held = await workspaceLicense(ws.workspaceId, inTerm())
    await assignSeat(actorOf(ws.admin), ws.workspaceId, held.licenseId, ws.memberMembershipId)

    const again = licenseWrite(ownerOf(ws.workspaceId), {...inTerm(), ...buyer(ws.member)})
    await store().putLicense(again)
    expect(await licenseRow(again.licenseId)).toMatchObject({seatsUsed: 0})

    // What doesn't count: another product, an expired or not-yet-started license of it, and the same product
    // held in another workspace.
    const fleet = await workspaceLicense(ws.workspaceId, {product: "mentra.fleet", ...inTerm()})
    await assignSeat(actorOf(ws.admin), ws.workspaceId, fleet.licenseId, ws.developerMembershipId)
    const expired = await workspaceLicense(ws.workspaceId, term(-60, -30))
    await assignSeat(actorOf(ws.admin), ws.workspaceId, expired.licenseId, ws.adminMembershipId)
    const upcoming = await workspaceLicense(ws.workspaceId, term(10, 40))
    await assignSeat(actorOf(ws.admin), ws.workspaceId, upcoming.licenseId, ws.ownerMembershipId)
    const dual = await person("dual")
    const dualMembershipId = await addMember(ws.workspaceId, dual, "member")
    const there = await workspaceLicense(other.workspaceId, inTerm())
    await assignSeat(
      actorOf(other.owner),
      other.workspaceId,
      there.licenseId,
      await addMember(other.workspaceId, dual, "member"),
    )
    await assignSeat(
      actorOf(other.owner),
      other.workspaceId,
      there.licenseId,
      await addMember(other.workspaceId, ws.member, "member"),
    )

    for (const [who, membershipId] of [
      [ws.developer, ws.developerMembershipId],
      [ws.admin, ws.adminMembershipId],
      [ws.owner, ws.ownerMembershipId],
      [dual, dualMembershipId],
    ] as const) {
      const write = licenseWrite(ownerOf(ws.workspaceId), {...inTerm(), ...buyer(who)})
      await store().putLicense(write)
      expect((await seatsOf(write.licenseId)).map((seat) => seat.membershipId)).toEqual([membershipId])
    }
    // In the other workspace, the member holds the product already.
    const inOther = licenseWrite(ownerOf(other.workspaceId), {...inTerm(), ...buyer(ws.member)})
    await store().putLicense(inOther)
    expect(await licenseRow(inOther.licenseId)).toMatchObject({seatsUsed: 0})
    const inThis = licenseWrite(ownerOf(ws.workspaceId), {product: "mentra.fleet", ...inTerm(), ...buyer(ws.member)})
    await store().putLicense(inThis)
    expect((await seatsOf(inThis.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.memberMembershipId])
  })

  test("the creating write delivered many times at once makes one license and one seat", async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await newWorkspace()
      const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(ws.member)})

      const results = await Promise.all(Array.from({length: 8}, () => store().putLicense(write)))

      expect(results.filter((result) => result.applied)).toHaveLength(1)
      expect(results.every((result) => result.revision === 1)).toBe(true)
      expect(await licenseRow(write.licenseId)).toMatchObject({seatsUsed: 1})
      expect((await seatsOf(write.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.memberMembershipId])
      expect((await eventsOf(write.licenseId)).map((event) => event.action)).toEqual([
        "license.written",
        "seat.assigned",
      ])
    }
  })

  test("two revisions of the first write racing, both naming the buyer, assign once", async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await newWorkspace()
      const first = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(ws.member)})
      const writes = [first, {...first, revision: 2}, first, {...first, revision: 2}]

      await Promise.allSettled(writes.map((write) => store().putLicense(write)))

      expect(await licenseRow(first.licenseId)).toMatchObject({revision: 2, seatsUsed: 1})
      expect((await seatsOf(first.licenseId)).map((seat) => seat.membershipId)).toEqual([ws.memberMembershipId])
      expect((await eventsOf(first.licenseId)).filter((event) => event.action === "seat.assigned")).toHaveLength(1)
    }
  })

  test("the creating write racing the buyer's removal never leaves a seat behind the ended membership", async () => {
    const ws = await newWorkspace()
    for (let round = 0; round < 5; round++) {
      const buyerPerson = await person(`buyer-${round}`)
      const membershipId = await addMember(ws.workspaceId, buyerPerson, "member")
      const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 5, ...inTerm(), ...buyer(buyerPerson)})

      const [written] = await Promise.allSettled([
        store().putLicense(write),
        removeMember(actorOf(ws.owner), ws.workspaceId, membershipId, await revisionOf(ws.workspaceId)),
      ])

      expect(written.status).toBe("fulfilled")
      expect((await WorkspaceMembershipModel.findOne({membershipId}).lean())!.status).toBe("ended")
      expect(await seatsOf(write.licenseId)).toEqual([])
      expect(await licenseRow(write.licenseId)).toMatchObject({seatsUsed: 0})
    }
  })
})

// --- A license added for oneself -------------------------------------------

describe("a license added for oneself", () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  /** A term from `fromDays` to `toDays` days around the real clock's now, which is what "in its term" asks about. */
  const term = (fromDays: number, toDays: number) => ({
    validFrom: new Date(Date.now() + fromDays * DAY_MS).toISOString(),
    paidThrough: new Date(Date.now() + toDays * DAY_MS).toISOString(),
  })
  const inTerm = () => term(-1, 30)
  const ownerOf = (workspaceId: string): LicenseOwner => ({type: "workspace", workspaceId})
  /** A request billing recorded when `who` opened an add-one session, expecting the license to reach `quantity`. */
  const request = (who: {mentraUserId: string}, quantity: number) => ({
    seatRequest: {requestId: newLicenseId(), mentraUserId: who.mentraUserId, quantity},
  })
  /** Every audit event of one license, in commit order. */
  const eventsOf = (licenseId: string) =>
    WorkspaceAuditEventModel.find({"target.licenseId": licenseId}).sort({seq: 1}).lean()
  const seatAssigned = async (licenseId: string) =>
    (await eventsOf(licenseId)).filter((event) => event.action === "seat.assigned")
  const holders = async (licenseId: string) => (await seatsOf(licenseId)).map((seat) => seat.mentraUserId)
  const requestsOf = async (licenseId: string) => (await licenseRow(licenseId))!.seatRequests

  /**
   * A workspace with a license of `quantity` (revision 1, in its term) whose every seat is assigned, by an
   * Admin, to members other than `asker`, an active member who holds none.
   */
  async function fullLicense(quantity = 5, overrides: Partial<LicenseWrite> = {}) {
    const ws = await newWorkspace()
    const asker = await person("asker")
    const askerMembershipId = await addMember(ws.workspaceId, asker, "member")
    const license = await workspaceLicense(ws.workspaceId, {quantity, ...inTerm(), ...overrides})
    const members = [ws.ownerMembershipId, ws.adminMembershipId, ws.developerMembershipId, ws.memberMembershipId]
    members.push(...(await addMembers(ws.workspaceId, Math.max(0, quantity - members.length))))
    const seated = members.slice(0, quantity)
    if (seated.length > 0) {
      await assignSeats(
        actorOf(ws.admin),
        ws.workspaceId,
        seated.map((membershipId) => ({licenseId: license.licenseId, membershipId})),
      )
    }
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity, seatsUsed: quantity})
    return {ws, asker, askerMembershipId, license}
  }

  test("the write that raises the quantity to the request's gives its person one, recorded after the write, by the Store", async () => {
    const {ws, asker, askerMembershipId, license} = await fullLicense(5)
    const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}

    expect(await store().putLicense(added)).toEqual({applied: true, revision: 2})

    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 6})
    expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
    expect((await seatsOf(license.licenseId)).find((seat) => seat.mentraUserId === asker.mentraUserId)).toMatchObject({
      workspaceId: ws.workspaceId,
      membershipId: askerMembershipId,
      assignedBy: null,
    })
    // What Core shows of the license names no request.
    expect(await store().listLicenses(ws.workspaceId)).toEqual({licenses: [viewOf(added, {seatsUsed: 6})]})
    // The person sees it as their own.
    const mine = await call("GET", `/api/workspaces/${ws.workspaceId}/licenses`, asker)
    expect((mine.json.items as LicenseView[]).map((view) => [view.licenseId, view.seats?.map((s) => s.membershipId)])).toEqual(
      [[license.licenseId, [askerMembershipId]]],
    )

    // After the Admin's five: `license.written`, then the request's `seat.assigned`, next to each other, both the Store's.
    const events = (await eventsOf(license.licenseId)).slice(-2)
    expect(events.map((event) => [event.action, event.actor])).toEqual([
      ["license.written", {kind: "service", service: "store"}],
      ["seat.assigned", {kind: "service", service: "store"}],
    ])
    expect(events[1]!.seq).toBe(events[0]!.seq! + 1)
    expect(events[0]).toMatchObject({before: {quantity: 5}, after: {revision: 2, quantity: 6}})
    expect(events[1]).toMatchObject({
      workspaceId: ws.workspaceId,
      target: {licenseId: license.licenseId, membershipId: askerMembershipId, mentraUserId: asker.mentraUserId},
      before: null,
      after: {seatsUsed: 6, quantity: 6},
    })
  })

  test("a request on the write that creates a license is a raise from 0, and gives its person one", async () => {
    const ws = await newWorkspace()
    const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 1, ...inTerm(), ...request(ws.member, 1)})

    expect(await store().putLicense(write)).toEqual({applied: true, revision: 1})

    expect(await holders(write.licenseId)).toEqual([ws.member.mentraUserId])
    expect(await requestsOf(write.licenseId)).toEqual([write.seatRequest!.requestId])
  })

  test("a request is decided once: a repeat, and later revisions still carrying it, give nothing, also after the person is unassigned", async () => {
    const {ws, asker, askerMembershipId, license} = await fullLicense(5)
    const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}
    await store().putLicense(added)
    expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 6})

    // Billing sends revision 2 again.
    expect(await store().putLicense(added)).toEqual({applied: false, revision: 2})
    expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 6})
    // Revision 3 still carries the request: nothing more.
    expect(await store().putLicense({...added, revision: 3})).toEqual({applied: true, revision: 3})
    expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 6})

    // An Admin unassigns them; revision 4 still carries the request and gives it back to no one.
    await releaseSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, askerMembershipId)
    expect(await store().putLicense({...added, revision: 4})).toEqual({applied: true, revision: 4})
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 5})
    // Even a write that raises the quantity to the request's again: the quantity dips to 5 and comes back to 6.
    await store().putLicense({...added, revision: 5, quantity: 5})
    await store().putLicense({...added, revision: 6, quantity: 6})
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 5})
    expect(await holders(license.licenseId)).not.toContain(asker.mentraUserId)
    expect(await seatAssigned(license.licenseId)).toHaveLength(6)
    expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
  })

  test("the raising write delivered many times at once gives one license", async () => {
    for (let round = 0; round < 3; round++) {
      const {asker, license} = await fullLicense(5)
      const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}

      const results = await Promise.all(Array.from({length: 8}, () => store().putLicense(added)))

      expect(results.filter((result) => result.applied)).toHaveLength(1)
      expect(results.every((result) => result.revision === 2)).toBe(true)
      expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 6})
      expect((await holders(license.licenseId)).filter((id) => id === asker.mentraUserId)).toHaveLength(1)
      expect((await seatAssigned(license.licenseId)).filter((e) => e.actor.kind === "service")).toHaveLength(1)
      expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
    }
  })

  test("the creating write with a request, delivered many times at once, gives one license", async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await newWorkspace()
      const write = licenseWrite(ownerOf(ws.workspaceId), {quantity: 3, ...inTerm(), ...request(ws.member, 3)})

      const results = await Promise.all(Array.from({length: 8}, () => store().putLicense(write)))

      expect(results.filter((result) => result.applied)).toHaveLength(1)
      expect(await licenseRow(write.licenseId)).toMatchObject({seatsUsed: 1})
      expect(await holders(write.licenseId)).toEqual([ws.member.mentraUserId])
      expect(await seatAssigned(write.licenseId)).toHaveLength(1)
    }
  })

  test("out of order and at once, revisions that all carry the request give one license", async () => {
    for (let round = 0; round < 3; round++) {
      const {asker, license} = await fullLicense(5)
      const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}
      const later = {...added, revision: 3}
      const writes = [later, added, later, added, added, later]

      await Promise.allSettled(writes.map((write) => store().putLicense(write)))

      expect(await licenseRow(license.licenseId)).toMatchObject({revision: 3, quantity: 6, seatsUsed: 6})
      expect((await holders(license.licenseId)).filter((id) => id === asker.mentraUserId)).toHaveLength(1)
      expect((await seatAssigned(license.licenseId)).filter((e) => e.actor.kind === "service")).toHaveLength(1)
      expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
    }
    // The later revision first, then the earlier one: the later decides, and the earlier is stale.
    const {asker, license} = await fullLicense(5)
    const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}
    expect(await store().putLicense({...added, revision: 3})).toEqual({applied: true, revision: 3})
    await expectClientError(store().putLicense(added), "stale_revision", 409)
    expect(await licenseRow(license.licenseId)).toMatchObject({revision: 3, seatsUsed: 6})
    expect((await holders(license.licenseId)).filter((id) => id === asker.mentraUserId)).toHaveLength(1)
  })

  test("a stale write carrying a request decides nothing: the next newer one still can", async () => {
    const {asker, license} = await fullLicense(5)
    await store().putLicense({...license, revision: 3})
    const stale = {...license, revision: 2, quantity: 6, ...request(asker, 6)}

    await expectClientError(store().putLicense(stale), "stale_revision", 409)
    expect(await licenseRow(license.licenseId)).toMatchObject({revision: 3, quantity: 5, seatsUsed: 5})
    expect(await requestsOf(license.licenseId)).toBeUndefined()

    expect(await store().putLicense({...stale, revision: 4})).toEqual({applied: true, revision: 4})
    expect(await holders(license.licenseId)).toContain(asker.mentraUserId)
  })

  test("no license from a write that doesn't raise the quantity to the request's, and the request is decided", async () => {
    // Core already has 6: revision 2 at 6 is no raise.
    const already = await fullLicense(6)
    const unchanged = {...already.license, revision: 2, quantity: 6, ...request(already.asker, 6)}
    await store().putLicense(unchanged)
    expect(await licenseRow(already.license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 6})
    expect(await requestsOf(already.license.licenseId)).toEqual([unchanged.seatRequest.requestId])

    // A request for 7 on a write of 6.
    const short = await fullLicense(5)
    const toSix = {...short.license, revision: 2, quantity: 6, ...request(short.asker, 7)}
    await store().putLicense(toSix)
    expect(await licenseRow(short.license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 5})
    expect(await requestsOf(short.license.licenseId)).toEqual([toSix.seatRequest.requestId])
    // Decided: the write that does reach 7 later, still carrying it, gives nothing either.
    await store().putLicense({...toSix, revision: 3, quantity: 7})
    expect(await licenseRow(short.license.licenseId)).toMatchObject({quantity: 7, seatsUsed: 5})
    expect(await holders(short.license.licenseId)).not.toContain(short.asker.mentraUserId)

    // A lowered quantity is no raise either.
    const lowered = await fullLicense(5)
    await store().putLicense({...lowered.license, revision: 2, quantity: 4, ...request(lowered.asker, 4)})
    expect(await holders(lowered.license.licenseId)).not.toContain(lowered.asker.mentraUserId)
  })

  test("no license for someone who is not an active member: never joined, left, or an Organization Admin outside it", async () => {
    const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
    const leaver = await person("leaver")
    const elsewhere = await newWorkspace("Elsewhere")

    for (const who of ["stranger", "leaver", "orgAdmin", "elsewhere", "never"] as const) {
      const {ws, license} = await fullLicense(5)
      if (who === "leaver") {
        await addMember(ws.workspaceId, leaver, "member")
        await leaveWorkspace(actorOf(leaver), ws.workspaceId)
      }
      const named = {
        stranger: ws.stranger,
        leaver,
        orgAdmin,
        elsewhere: elsewhere.member,
        never: {mentraUserId: "mu_never"},
      }[who]
      const added = {...license, revision: 2, quantity: 6, ...request(named, 6)}
      expect(await store().putLicense(added)).toEqual({applied: true, revision: 2})
      expect([who, await licenseRow(license.licenseId)]).toMatchObject([who, {quantity: 6, seatsUsed: 5}])
      expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
      expect(await LicenseSeatModel.countDocuments({mentraUserId: named.mentraUserId})).toBe(0)
    }
  })

  test("no second license of a product the person already holds there in its term; an expired one or another product doesn't count", async () => {
    const {ws, asker, askerMembershipId, license} = await fullLicense(5)
    const held = await workspaceLicense(ws.workspaceId, inTerm())
    await assignSeat(actorOf(ws.admin), ws.workspaceId, held.licenseId, askerMembershipId)

    const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}
    await store().putLicense(added)
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 5})
    expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])

    // Another product, and an expired license of this one, don't count.
    const other = await fullLicense(5)
    const fleet = await workspaceLicense(other.ws.workspaceId, {product: "mentra.fleet", ...inTerm()})
    await assignSeat(actorOf(other.ws.admin), other.ws.workspaceId, fleet.licenseId, other.askerMembershipId)
    const expired = await workspaceLicense(other.ws.workspaceId, term(-60, -30))
    await assignSeat(actorOf(other.ws.admin), other.ws.workspaceId, expired.licenseId, other.askerMembershipId)
    await store().putLicense({...other.license, revision: 2, quantity: 6, ...request(other.asker, 6)})
    expect(await holders(other.license.licenseId)).toContain(other.asker.mentraUserId)
  })

  test("a person who already holds this license's seat gets no second one, in its term or not", async () => {
    // The license hasn't started yet, so the seat they hold isn't an in-term one.
    const upcoming = term(10, 40)
    const {ws, asker, askerMembershipId, license} = await fullLicense(5, upcoming)
    await releaseSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, ws.memberMembershipId)
    await assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, askerMembershipId)

    const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}
    expect(await store().putLicense(added)).toEqual({applied: true, revision: 2})
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 5})
    expect((await holders(license.licenseId)).filter((id) => id === asker.mentraUserId)).toHaveLength(1)
    expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
  })

  test("no license when no seat is free: seats used were already past the raised quantity", async () => {
    const {asker, license} = await fullLicense(6)
    // Billing lowers it to 5, which frees no seat, then the request's write brings it back to 6.
    await store().putLicense({...license, revision: 2, quantity: 5})
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 5, seatsUsed: 6})

    const added = {...license, revision: 3, quantity: 6, ...request(asker, 6)}
    expect(await store().putLicense(added)).toEqual({applied: true, revision: 3})
    expect(await licenseRow(license.licenseId)).toMatchObject({quantity: 6, seatsUsed: 6})
    expect(await holders(license.licenseId)).not.toContain(asker.mentraUserId)
    expect(await requestsOf(license.licenseId)).toEqual([added.seatRequest.requestId])
  })

  test("the raising write racing an Admin's assignment of the new seat never passes the quantity", async () => {
    for (let round = 0; round < 5; round++) {
      const {ws, asker, license} = await fullLicense(5)
      const [other] = await addMembers(ws.workspaceId, 1)
      const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}

      const [written] = await Promise.allSettled([
        store().putLicense(added),
        assignSeat(actorOf(ws.admin), ws.workspaceId, license.licenseId, other!),
      ])

      expect(written.status).toBe("fulfilled")
      const row = (await licenseRow(license.licenseId))!
      expect(row.quantity).toBe(6)
      expect(row.seatsUsed).toBeLessThanOrEqual(6)
      expect(await seatsOf(license.licenseId)).toHaveLength(row.seatsUsed)
      expect((await holders(license.licenseId)).filter((id) => id === asker.mentraUserId).length).toBeLessThanOrEqual(1)
    }
  })

  test("the raising write racing the person's removal never leaves a seat behind the ended membership", async () => {
    for (let round = 0; round < 5; round++) {
      const {ws, asker, askerMembershipId, license} = await fullLicense(5)
      const added = {...license, revision: 2, quantity: 6, ...request(asker, 6)}

      const [written] = await Promise.allSettled([
        store().putLicense(added),
        removeMember(actorOf(ws.owner), ws.workspaceId, askerMembershipId, await revisionOf(ws.workspaceId)),
      ])

      expect(written.status).toBe("fulfilled")
      expect((await WorkspaceMembershipModel.findOne({membershipId: askerMembershipId}).lean())!.status).toBe("ended")
      expect(await LicenseSeatModel.countDocuments({membershipId: askerMembershipId})).toBe(0)
      expect(await licenseRow(license.licenseId)).toMatchObject({seatsUsed: 5})
    }
  })

  test("never the buyer again: after the buyer is unassigned, a later write naming them assigns no one", async () => {
    const ws = await newWorkspace()
    const purchase = licenseWrite(ownerOf(ws.workspaceId), {
      quantity: 1,
      ...inTerm(),
      assignTo: {mentraUserId: ws.owner.mentraUserId},
    })
    await store().putLicense(purchase)
    expect(await holders(purchase.licenseId)).toEqual([ws.owner.mentraUserId])

    await releaseSeat(actorOf(ws.admin), ws.workspaceId, purchase.licenseId, ws.ownerMembershipId)
    expect(await store().putLicense({...purchase, revision: 2, quantity: 3})).toEqual({applied: true, revision: 2})
    expect(await licenseRow(purchase.licenseId)).toMatchObject({quantity: 3, seatsUsed: 0})

    // A request names whoever opened the session, never the buyer billing names alongside it.
    const added = {...purchase, revision: 3, quantity: 4, ...request(ws.member, 4)}
    await store().putLicense(added)
    expect(await holders(purchase.licenseId)).toEqual([ws.member.mentraUserId])
    expect((await eventsOf(purchase.licenseId)).map((event) => event.action)).toEqual([
      "license.written",
      "seat.assigned",
      "seat.released",
      "license.written",
      "license.written",
      "seat.assigned",
    ])
  })

  test("a write without a request behaves as before, and leaves no request list on the license", async () => {
    const {license} = await fullLicense(5)
    expect(await store().putLicense({...license, revision: 2, quantity: 6})).toEqual({applied: true, revision: 2})

    const row = (await licenseRow(license.licenseId))!
    expect(row).toMatchObject({quantity: 6, seatsUsed: 5})
    expect("seatRequests" in row).toBe(false)
    const fresh = await workspaceLicense(license.owner.workspaceId, inTerm())
    expect("seatRequests" in (await licenseRow(fresh.licenseId))!).toBe(false)
  })

  test("a malformed seatRequest is 400 invalid_request, and Core keeps nothing of the write", async () => {
    const {asker, license} = await fullLicense(5)
    for (const seatRequest of [
      null,
      {mentraUserId: asker.mentraUserId, quantity: 6},
      {requestId: "r1", mentraUserId: " ", quantity: 6},
      {requestId: "r1", mentraUserId: asker.mentraUserId, quantity: 0},
      {requestId: "r1", mentraUserId: asker.mentraUserId, quantity: 1.5},
      {requestId: "r1", mentraUserId: asker.mentraUserId, quantity: "6"},
    ]) {
      const body = {...license, revision: 2, quantity: 6, seatRequest}
      expect(await signed("PUT", `${LICENSES}/${license.licenseId}`, {body})).toMatchObject({
        status: 400,
        json: {error: "invalid_request"},
      })
    }
    expect(await licenseRow(license.licenseId)).toMatchObject({revision: 1, quantity: 5, seatsUsed: 5})
  })
})
