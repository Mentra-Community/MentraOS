/**
 * @fileoverview The `workspaceId` and `localBuild` claims of a miniapp token, and the assigned-package contract.
 *
 * Fleet tells Core which miniapps each workspace assigns (`PUT /api/internal/fleet/workspaces/:workspaceId/
 * assigned-packages`, signed as service `fleet`), and `POST /api/client/auth/miniapp-token` names the person's
 * workspace only for a package their workspace assigned. A local build's token says so and never names a
 * workspace. Everything runs through the real app against real workspace, membership and assigned-package rows
 * on a local replica set; leaving and deleting go through the real workspace services.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call. The
 * database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/miniapp-token-claims.integration.test.ts`
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
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {LicenseSeatModel} from "../packages/core/src/models/license-seat.model"
import {LicenseModel} from "../packages/core/src/models/license.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAssignedPackagesModel} from "../packages/core/src/models/workspace-assigned-packages.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import * as trustedEmail from "../packages/core/src/services/account/trusted-email.service"
import * as session from "../packages/core/src/services/session.service"
import * as workspaceService from "../packages/core/src/services/workspaces/workspace.service"
import {deleteWorkspace, leaveWorkspace} from "../packages/core/src/services/workspaces/workspace.service"
import {SERVICE_HEADERS, signServiceRequest} from "../packages/workspace-contract/src/server"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {applyEnv} from "./support/signin-harness"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  LicenseModel,
  LicenseSeatModel,
  UserModel,
  WorkspaceAssignedPackagesModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const SERVICE_SECRETS = {store: ["store-s1"], fleet: ["fleet-f1", "fleet-f0"]}
const BASE = "https://core.test"
const ACME_TOOLS = "com.acme.tools"
const NOTES = "com.example.notes"
const strip = (pem: string) => pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database; every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let restoreEnv: () => void = () => {}
/** Who the phone's access token names. */
let signedIn = "mu_alice"
const mocks: Array<{mockRestore(): void}> = []

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("miniapp-token-claims")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another test file would
  // silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations do not run here; the writes and lookups should meet the indexes they run on.
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
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  restoreEnv = applyEnv({
    CLOUD_CORE_SERVICE_SECRETS: JSON.stringify(SERVICE_SECRETS),
    CLOUD_CORE_ENABLED_FEATURES: undefined,
    MENTRA_MINIAPP_JWT_PRIVATE_KEY: strip(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    MENTRA_MINIAPP_JWT_PUBLIC_KEY: strip(publicKey.export({type: "spki", format: "pem"}).toString()),
  })
  session.resetSigningKeyCache()
  signedIn = "mu_alice"
  mocks.push(
    spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue(null),
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
  )
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map((model) => model.deleteMany({})))
})

afterEach(() => {
  setSystemTime()
  for (const mock of mocks.splice(0)) mock.mockRestore()
  restoreEnv()
  session.resetSigningKeyCache()
})

// --- Fixtures --------------------------------------------------------------

let counter = 0

/** An active workspace with `members` (the first is its owner, the rest members). */
async function workspace(workspaceId: string, members: string[]): Promise<void> {
  await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
  for (const [index, mentraUserId] of members.entries()) {
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: `wm_${counter++}`,
        workspaceId,
        mentraUserId,
        role: index === 0 ? "owner" : "member",
        status: "active",
        startedAt: new Date(Date.now() - (members.length - index) * 1000),
      }),
    )
  }
}

/** The phone's token request for `packageName`, as `signedIn`. */
async function postMiniappToken(body: Record<string, unknown>): Promise<Response> {
  return app.request(`${BASE}/api/client/auth/miniapp-token`, {
    method: "POST",
    headers: {"Authorization": "Bearer access", "Content-Type": "application/json"},
    body: JSON.stringify(body),
  })
}

/** The verified claims of `signedIn`'s token for `packageName`. */
async function mint(packageName: string, extra: Record<string, unknown> = {}): Promise<jose.JWTPayload> {
  const response = await postMiniappToken({packageName, ...extra})
  expect(response.status).toBe(200)
  const {token} = (await response.json()) as {token: string}
  const pem = `-----BEGIN PUBLIC KEY-----\n${process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  const key = await jose.importSPKI(pem, "EdDSA")
  return (await jose.jwtVerify(token, key, {issuer: "cloud-core", audience: packageName})).payload
}

interface SignOptions {
  service?: string
  secret?: string
  /** Sign this body instead of the one sent. */
  signedBody?: string
  rawBody?: string
}

/** A signed `PUT .../assigned-packages`, as Fleet sends it. */
async function putAssigned(workspaceId: string, body: unknown, options: SignOptions = {}) {
  const path = `/api/internal/fleet/workspaces/${encodeURIComponent(workspaceId)}/assigned-packages`
  const text = options.rawBody ?? JSON.stringify(body)
  const timestampMs = Date.now()
  const response = await app.request(`${BASE}${path}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      [SERVICE_HEADERS.service]: options.service ?? "fleet",
      [SERVICE_HEADERS.timestamp]: String(timestampMs),
      [SERVICE_HEADERS.signature]: signServiceRequest({
        secret: options.secret ?? "fleet-f1",
        method: "PUT",
        pathWithQuery: path,
        body: options.signedBody ?? text,
        timestampMs,
      }),
    },
    body: text,
  })
  const answer = await response.text()
  let json: any = null
  try {
    json = answer ? JSON.parse(answer) : null
  } catch {
    // A non-JSON body shows up as a failed assertion on `json`.
  }
  return {status: response.status, json}
}

/** Fleet assigns `packageNames` to the workspace at `revision`; the push must apply. */
async function assign(workspaceId: string, packageNames: string[], revision: number): Promise<void> {
  const {status, json} = await putAssigned(workspaceId, {packageNames, revision})
  expect({status, applied: json?.applied}).toEqual({status: 200, applied: true})
}

const alice = {
  kind: "user" as const,
  mentraUserId: "mu_alice",
  email: "alice@example.test",
  emailVerified: true,
  isOrganizationAdmin: false,
}

// --- The workspace claim ---------------------------------------------------

describe("the workspaceId claim", () => {
  test("is absent for a package the person's workspace has not assigned", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)

    expect("workspaceId" in (await mint(NOTES))).toBe(false)
  })

  test("is absent for a person in no workspace, and for a workspace that assigned nothing", async () => {
    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
  })

  test("names the person's workspace for a package it assigned", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS, NOTES], 1)

    expect(await mint(ACME_TOOLS)).toMatchObject({sub: "mu_alice", aud: ACME_TOOLS, workspaceId: "ws_acme"})
    expect((await mint(NOTES)).workspaceId).toBe("ws_acme")
    expect("localBuild" in (await mint(ACME_TOOLS))).toBe(false)
  })

  test("never names another workspace that assigned the package", async () => {
    await workspace("ws_acme", ["mu_owner"])
    await workspace("ws_globex", ["mu_globex_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)

    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
    signedIn = "mu_owner"
    expect((await mint(ACME_TOOLS)).workspaceId).toBe("ws_acme")
  })

  test("names the workspace joined first when, from before one workspace per person, several assigned it", async () => {
    for (const [workspaceId, startedAt] of [
      ["ws_later", new Date("2026-06-01T00:00:00.000Z")],
      ["ws_first", new Date("2026-01-01T00:00:00.000Z")],
    ] as const) {
      await WorkspaceModel.create({workspaceId, name: `Workspace ${workspaceId}`, status: "active"})
      await WorkspaceMembershipModel.create(
        membershipRow({
          membershipId: `wm_${workspaceId}`,
          workspaceId,
          mentraUserId: "mu_alice",
          role: "owner",
          status: "active",
          startedAt,
        }),
      )
      await assign(workspaceId, [ACME_TOOLS], 1)
    }

    expect((await mint(ACME_TOOLS)).workspaceId).toBe("ws_first")
  })

  test("is gone once the person leaves the workspace", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)
    expect((await mint(ACME_TOOLS)).workspaceId).toBe("ws_acme")

    await leaveWorkspace(alice, "ws_acme")

    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
  })

  test("is gone once Fleet withdraws the package, and back when it assigns it again", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS, NOTES], 1)

    await assign("ws_acme", [NOTES], 2)
    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
    expect((await mint(NOTES)).workspaceId).toBe("ws_acme")

    await assign("ws_acme", [], 3)
    expect("workspaceId" in (await mint(NOTES))).toBe(false)

    await assign("ws_acme", [ACME_TOOLS], 4)
    expect((await mint(ACME_TOOLS)).workspaceId).toBe("ws_acme")
  })

  test("is gone with the workspace: deleting it deletes its set", async () => {
    await workspace("ws_acme", ["mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)

    await deleteWorkspace({kind: "system"}, "ws_acme", {confirmName: "Workspace ws_acme"})

    expect(await WorkspaceAssignedPackagesModel.countDocuments({workspaceId: "ws_acme"})).toBe(0)
    expect("workspaceId" in (await mint(ACME_TOOLS))).toBe(false)
  })
})

// --- Local builds ----------------------------------------------------------

describe("a local build's token", () => {
  test("is marked, and never names the workspace, even for an assigned package", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)

    const claims = await mint(ACME_TOOLS, {localBuild: true})
    expect(claims).toMatchObject({sub: "mu_alice", aud: ACME_TOOLS, tenantId: "mentra", localBuild: true})
    expect("workspaceId" in claims).toBe(false)
  })

  test("is asked for with a boolean: anything else, null included, is 400 invalid_request", async () => {
    for (const localBuild of [null, "true", 1]) {
      const response = await postMiniappToken({packageName: ACME_TOOLS, localBuild})
      expect({localBuild, status: response.status, error: ((await response.json()) as {error?: string}).error}).toEqual({
        localBuild,
        status: 400,
        error: "invalid_request",
      })
    }
  })

  test("is the installed miniapp's token when the phone says it is not a local build", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 1)

    const claims = await mint(ACME_TOOLS, {localBuild: false})
    expect(claims.workspaceId).toBe("ws_acme")
    expect("localBuild" in claims).toBe(false)
  })
})

describe("a token for an unassigned, installed miniapp", () => {
  test("carries exactly the claims a miniapp token always carried", async () => {
    await workspace("ws_acme", ["mu_owner", "mu_alice"])

    expect(Object.keys(await mint(NOTES)).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub", "tenantId"])
  })
})

// --- The assigned-package contract -----------------------------------------

describe("PUT /api/internal/fleet/workspaces/:workspaceId/assigned-packages", () => {
  test("replaces the set and answers it, unique and sorted", async () => {
    await workspace("ws_acme", ["mu_owner"])

    const first = await putAssigned("ws_acme", {packageNames: [NOTES, ACME_TOOLS, NOTES], revision: 1})
    expect(first).toEqual({
      status: 200,
      json: {workspaceId: "ws_acme", packageNames: [ACME_TOOLS, NOTES], revision: 1, applied: true},
    })
    const second = await putAssigned("ws_acme", {packageNames: [NOTES], revision: 7})
    expect(second.json).toEqual({workspaceId: "ws_acme", packageNames: [NOTES], revision: 7, applied: true})

    const row = await WorkspaceAssignedPackagesModel.findOne({workspaceId: "ws_acme"}).lean()
    expect(row).toMatchObject({packageNames: [NOTES], revision: 7})
    expect(row?.updatedAt).toBeInstanceOf(Date)
  })

  test("accepts revision 0 and an empty set as a workspace's first push", async () => {
    await workspace("ws_acme", ["mu_owner"])
    expect((await putAssigned("ws_acme", {packageNames: [], revision: 0})).json).toEqual({
      workspaceId: "ws_acme",
      packageNames: [],
      revision: 0,
      applied: true,
    })
  })

  test("refuses an older revision with Core's, and changes nothing", async () => {
    await workspace("ws_acme", ["mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 5)

    const stale = await putAssigned("ws_acme", {packageNames: [], revision: 4})
    expect(stale.status).toBe(409)
    expect(stale.json).toMatchObject({error: "stale_revision", revision: 5})
    expect((await mint(ACME_TOOLS)).workspaceId).toBe("ws_acme")
  })

  test("answers a repeat of Core's revision with the set Core keeps, applied false", async () => {
    await workspace("ws_acme", ["mu_alice"])
    await assign("ws_acme", [ACME_TOOLS], 5)

    const repeat = await putAssigned("ws_acme", {packageNames: [NOTES], revision: 5})
    expect(repeat).toEqual({
      status: 200,
      json: {workspaceId: "ws_acme", packageNames: [ACME_TOOLS], revision: 5, applied: false},
    })
    expect("workspaceId" in (await mint(NOTES))).toBe(false)
  })

  test("concurrent first pushes leave the newest revision", async () => {
    await workspace("ws_acme", ["mu_owner"])
    const pushes = await Promise.all(
      [1, 2, 3, 4].map((revision) => putAssigned("ws_acme", {packageNames: [`com.acme.app${revision}`], revision})),
    )
    for (const push of pushes) expect([200, 409]).toContain(push.status)
    expect(await WorkspaceAssignedPackagesModel.findOne({workspaceId: "ws_acme"}).lean()).toMatchObject({
      packageNames: ["com.acme.app4"],
      revision: 4,
    })
  })

  test("a first push that read the workspace before a concurrent deletion committed never lands", async () => {
    await workspace("ws_acme", ["mu_owner"])
    // The clock stands still at the workspace's last write, so a push that only stamps the time would
    // write nothing to the workspace document and could not conflict with the deletion.
    const frozen = new Date("2026-10-23T12:00:00.000Z")
    await WorkspaceModel.collection.updateOne({workspaceId: "ws_acme"}, {$set: {updatedAt: frozen}})
    setSystemTime(frozen)

    // Hold the push's transaction open just after it has read the workspace as active.
    const loadActiveWorkspace = workspaceService.loadActiveWorkspace
    let reached: () => void = () => {}
    const pushHasRead = new Promise<void>((resolve) => (reached = resolve))
    let release: () => void = () => {}
    const deletionCommitted = new Promise<void>((resolve) => (release = resolve))
    let held = false
    mocks.push(
      spyOn(workspaceService, "loadActiveWorkspace").mockImplementation(async (session, workspaceId) => {
        const row = await loadActiveWorkspace(session, workspaceId)
        if (!held) {
          held = true
          reached()
          await deletionCommitted
        }
        return row
      }),
    )

    const push = putAssigned("ws_acme", {packageNames: [ACME_TOOLS], revision: 1})
    await pushHasRead
    await deleteWorkspace({kind: "system"}, "ws_acme", {confirmName: "Workspace ws_acme"})
    release()

    const {status, json} = await push
    expect({status, error: json?.error}).toEqual({status: 410, error: "workspace_deleted"})
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)
  })

  test("answers 404 workspace_not_found for a workspace Core never had, and stores nothing", async () => {
    const {status, json} = await putAssigned("ws_nowhere", {packageNames: [ACME_TOOLS], revision: 1})
    expect(status).toBe(404)
    expect(json).toEqual({error: "workspace_not_found"})
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)
  })

  test("answers 410 workspace_deleted for a deleted workspace, and stores nothing", async () => {
    await workspace("ws_acme", ["mu_alice"])
    await deleteWorkspace({kind: "system"}, "ws_acme", {confirmName: "Workspace ws_acme"})

    const {status, json} = await putAssigned("ws_acme", {packageNames: [ACME_TOOLS], revision: 1})
    expect(status).toBe(410)
    expect(json?.error).toBe("workspace_deleted")
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)
  })

  test("refuses a malformed push with 400 invalid_request", async () => {
    await workspace("ws_acme", ["mu_owner"])
    const bodies: unknown[] = [
      {packageNames: [ACME_TOOLS]},
      {packageNames: [ACME_TOOLS], revision: -1},
      {packageNames: [ACME_TOOLS], revision: 1.5},
      {packageNames: [ACME_TOOLS], revision: "2"},
      {packageNames: ACME_TOOLS, revision: 1},
      {packageNames: [""], revision: 1},
      {packageNames: ["com.acme tools"], revision: 1},
      {packageNames: [7], revision: 1},
      {packageNames: [`com.${"a".repeat(130)}`], revision: 1},
      {packageNames: Array.from({length: 501}, (_, index) => `com.acme.app${index}`), revision: 1},
      [ACME_TOOLS],
    ]
    for (const body of bodies) {
      const {status, json} = await putAssigned("ws_acme", body)
      expect({body, status, error: json?.error}).toEqual({body, status: 400, error: "invalid_request"})
    }
    expect((await putAssigned("ws_acme", null, {rawBody: "not json"})).status).toBe(400)
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)
  })

  test("refuses a body over 64 KiB with 413", async () => {
    await workspace("ws_acme", ["mu_owner"])
    const body = {packageNames: [ACME_TOOLS], revision: 1, padding: "x".repeat(70 * 1024)}
    expect((await putAssigned("ws_acme", body)).status).toBe(413)
  })

  test("is Fleet's: a store-signed call is 403 forbidden", async () => {
    await workspace("ws_acme", ["mu_owner"])
    const {status, json} = await putAssigned(
      "ws_acme",
      {packageNames: [ACME_TOOLS], revision: 1},
      {service: "store", secret: "store-s1"},
    )
    expect(status).toBe(403)
    expect(json).toEqual({error: "forbidden"})
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)
  })

  test("refuses a call that is not signed with Fleet's secret, or whose body is not the one signed", async () => {
    await workspace("ws_acme", ["mu_owner"])
    const body = {packageNames: [ACME_TOOLS], revision: 1}

    expect((await putAssigned("ws_acme", body, {secret: "store-s1"})).json).toEqual({error: "service_unauthorized"})
    const tampered = await putAssigned("ws_acme", body, {signedBody: JSON.stringify({packageNames: [], revision: 1})})
    expect(tampered).toEqual({status: 401, json: {error: "service_unauthorized"}})
    const unsigned = await app.request(`${BASE}/api/internal/fleet/workspaces/ws_acme/assigned-packages`, {
      method: "PUT",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    })
    expect(unsigned.status).toBe(401)
    expect(await WorkspaceAssignedPackagesModel.countDocuments({})).toBe(0)

    // A secret Fleet is rotating away from still signs.
    expect((await putAssigned("ws_acme", body, {secret: "fleet-f0"})).status).toBe(200)
  })
})
