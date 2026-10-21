/**
 * @fileoverview Fleet's reads of Core: membership interval history, and member lists with names.
 *
 * Real services, models and transactions against a local replica set; requests to the internal API are signed
 * by hand as service `fleet` (or `store`, which must be refused).
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/membership-history.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import type {Model} from "mongoose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {LegacyBrowserIdentityModel} from "../packages/core/src/models/legacy-browser-identity.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {claimLegacyIdentitiesOnce} from "../packages/core/src/services/workspaces/membership-claim.service"
import {
  fleetHistoryMaxDays,
  listMembershipIntervals,
} from "../packages/core/src/services/workspaces/membership-history.service"
import {toMemberViews} from "../packages/core/src/services/workspaces/member-view.service"
import {
  createWorkspace,
  deleteWorkspace,
  leaveWorkspace,
  listMembers,
  removeMember,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {SERVICE_HEADERS, signServiceRequest} from "../packages/workspace-contract/src/server"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

const MODELS: Model<any>[] = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  SigninIdentityModel,
  LegacyBrowserIdentityModel,
  UserModel,
]

const BASE = "https://core.test"
const API = "/api/internal/workspaces"
const DAY_MS = 86_400_000
const SECRETS = {store: ["store-s1"], fleet: ["fleet-f1"]}

let databaseUrl: string
let verified = false
let app: ReturnType<typeof createApp>
let savedSecrets: string | undefined
let savedLookback: string | undefined

type UserActor = Actor & {kind: "user"}
const actor = (id: string): UserActor => ({
  kind: "user",
  mentraUserId: id,
  email: `${id}@example.test`,
  emailVerified: true,
  isOrganizationAdmin: false,
})
const owner = actor("mu_owner")

async function call(path: string, service: "fleet" | "store" = "fleet") {
  const timestampMs = Date.now()
  const secret = service === "fleet" ? "fleet-f1" : "store-s1"
  const response = await app.fetch(
    new Request(`${BASE}${path}`, {
      method: "GET",
      headers: {
        [SERVICE_HEADERS.service]: service,
        [SERVICE_HEADERS.timestamp]: String(timestampMs),
        [SERVICE_HEADERS.signature]: signServiceRequest({secret, method: "GET", pathWithQuery: path, body: "", timestampMs}),
      },
    }),
  )
  const text = await response.text()
  return {status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers}
}

async function member(workspaceId: string, mentraUserId: string, role: string, fields: Record<string, unknown> = {}) {
  const startedAt = (fields.startedAt as Date | undefined) ?? new Date()
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId: `wm_${mentraUserId}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId,
      mentraUserId,
      email: `${mentraUserId}@example.test`,
      role,
      status: "active",
      ...fields,
      startedAt,
    }),
  )
}

async function workspace() {
  return (await createWorkspace(owner, {name: "Acme"})).workspaceId
}

async function allIntervals(now?: Date) {
  const out = []
  let after: string | null = null
  do {
    const page = await listMembershipIntervals({after, limit: 2, ...(now ? {now} : {})})
    out.push(...page.intervals)
    after = page.next
  } while (after)
  return out
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("membership-history")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  savedSecrets = process.env.CLOUD_CORE_SERVICE_SECRETS
  savedLookback = process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS
  process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify(SECRETS)
  delete process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS
})

afterEach(() => {
  if (savedSecrets === undefined) delete process.env.CLOUD_CORE_SERVICE_SECRETS
  else process.env.CLOUD_CORE_SERVICE_SECRETS = savedSecrets
  if (savedLookback === undefined) delete process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS
  else process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS = savedLookback
})

describe("fleetHistoryMaxDays", () => {
  test("defaults to 90 and reads a whole number of days", () => {
    expect(fleetHistoryMaxDays({})).toBe(90)
    expect(fleetHistoryMaxDays({CLOUD_CORE_FLEET_HISTORY_MAX_DAYS: " 120 "})).toBe(120)
    expect(fleetHistoryMaxDays({CLOUD_CORE_FLEET_HISTORY_MAX_DAYS: "3650"})).toBe(3650)
  })

  test("a bad value is a configuration error, not a silent default", () => {
    for (const bad of ["0", "-5", "1.5", "ninety", "3651", "1e2", "07"]) {
      expect(() => fleetHistoryMaxDays({CLOUD_CORE_FLEET_HISTORY_MAX_DAYS: bad})).toThrow(/CLOUD_CORE_FLEET_HISTORY_MAX_DAYS/)
    }
  })
})

describe("membership intervals", () => {
  test("an open member starts at join and has no end; the owner's membership is one too", async () => {
    const ws = await workspace()
    await member(ws, "mu_a", "member")
    const intervals = await allIntervals()
    expect(intervals.map(i => [i.mentraUserId, i.end, i.endReason]).sort()).toEqual([
      ["mu_a", null, null],
      ["mu_owner", null, null],
    ])
    expect(intervals.every(i => i.workspaceId === ws)).toBe(true)
  })

  test("joined, left, rejoined: two intervals with two membership ids, the first closed as left", async () => {
    const ws = await workspace()
    await member(ws, "mu_a", "member", {startedAt: new Date(Date.now() - 20 * DAY_MS)})
    await leaveWorkspace(actor("mu_a"), ws)
    await member(ws, "mu_a", "developer")
    const mine = (await allIntervals()).filter(i => i.mentraUserId === "mu_a")
    expect(mine).toHaveLength(2)
    const closed = mine.find(i => i.end !== null)!
    const open = mine.find(i => i.end === null)!
    expect(closed.endReason).toBe("left")
    expect(open.role).toBe("developer")
    expect(closed.membershipId).not.toBe(open.membershipId)
    expect(Date.parse(closed.end!)).toBeLessThanOrEqual(Date.parse(open.start))
  })

  test("removed ends as removed; the workspace deleted ends everyone as workspace_deleted", async () => {
    const ws = await workspace()
    await member(ws, "mu_a", "member")
    await member(ws, "mu_b", "member")
    const a = (await listMembers(ws)).find(row => row.mentraUserId === "mu_a")!
    const revision = (await WorkspaceModel.findOne({workspaceId: ws}).lean())!.authorizationRevision
    await removeMember(owner, ws, a.membershipId, revision)
    let byUser = new Map((await allIntervals()).map(i => [i.mentraUserId, i]))
    expect(byUser.get("mu_a")).toMatchObject({endReason: "removed"})
    expect(byUser.get("mu_b")!.end).toBeNull()

    await deleteWorkspace(owner, ws, {confirmName: "Acme"})
    byUser = new Map((await allIntervals()).map(i => [i.mentraUserId, i]))
    expect(byUser.get("mu_b")).toMatchObject({endReason: "workspace_deleted"})
    expect(byUser.get("mu_owner")).toMatchObject({endReason: "workspace_deleted"})
  })

  test("a membership ended by account deletion reports account_deleted", async () => {
    const ws = await workspace()
    await member(ws, "mu_a", "member")
    await WorkspaceMembershipModel.updateOne(
      {workspaceId: ws, mentraUserId: "mu_a"},
      {$set: {status: "ended", endedAt: new Date(), endedReason: "account_deleted"}},
    )
    const mine = (await allIntervals()).find(i => i.mentraUserId === "mu_a")!
    expect(mine.endReason).toBe("account_deleted")
  })

  test("a member who joined 200 days ago, with a 90-day lookback, is returned open with the real start", async () => {
    const ws = await workspace()
    const started = new Date(Date.now() - 200 * DAY_MS)
    await member(ws, "mu_old", "member", {startedAt: started})
    const page = await listMembershipIntervals({})
    expect(page.lookbackDays).toBe(90)
    const old = page.intervals.find(i => i.mentraUserId === "mu_old")!
    expect(old.end).toBeNull()
    expect(old.start).toBe(started.toISOString())
    expect(Date.parse(old.start)).toBeLessThan(Date.parse(page.windowStart))
  })

  test("an interval that ended before the window is not returned; one that ended inside it is", async () => {
    const ws = await workspace()
    await member(ws, "mu_gone", "member", {
      startedAt: new Date(Date.now() - 300 * DAY_MS),
      status: "ended",
      endedAt: new Date(Date.now() - 100 * DAY_MS),
      endedReason: "left",
    })
    await member(ws, "mu_recent", "member", {
      startedAt: new Date(Date.now() - 300 * DAY_MS),
      status: "ended",
      endedAt: new Date(Date.now() - 30 * DAY_MS),
      endedReason: "removed",
    })
    const ids = (await allIntervals()).map(i => i.mentraUserId)
    expect(ids).toContain("mu_recent")
    expect(ids).not.toContain("mu_gone")
  })

  test("the lookback is configurable: 120 days returns what 90 does not", async () => {
    const ws = await workspace()
    await member(ws, "mu_114", "member", {
      startedAt: new Date(Date.now() - 300 * DAY_MS),
      status: "ended",
      endedAt: new Date(Date.now() - 110 * DAY_MS),
      endedReason: "left",
    })
    expect((await allIntervals()).map(i => i.mentraUserId)).not.toContain("mu_114")
    process.env.CLOUD_CORE_FLEET_HISTORY_MAX_DAYS = "120"
    const page = await listMembershipIntervals({})
    expect(page.lookbackDays).toBe(120)
    expect((await allIntervals()).map(i => i.mentraUserId)).toContain("mu_114")
  })

  test("an imported membership waiting for its person is not an interval; once claimed it starts at the claim", async () => {
    const ws = await workspace()
    const importedAt = new Date(Date.now() - 40 * DAY_MS)
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_imported",
        workspaceId: ws,
        mentraUserId: null,
        pendingWorkosUserId: "user_workos_1",
        email: "imp@example.test",
        role: "developer",
        status: "active",
        startedAt: importedAt,
      }),
    )
    expect((await allIntervals()).map(i => i.membershipId)).not.toContain("wm_imported")

    await UserModel.create({mentraUserId: "mu_imp", tenantId: "mentra", tenantUserId: "sb-imp"})
    await LegacyBrowserIdentityModel.create({workosUserId: "user_workos_1", email: "imp@example.test"})
    const before = Date.now()
    await claimLegacyIdentitiesOnce({mentraUserId: "mu_imp", email: "imp@example.test", emailVerified: true})
    const row = (await WorkspaceMembershipModel.findOne({membershipId: "wm_imported"}).lean())!
    expect(row.mentraUserId).toBe("mu_imp")
    expect(row.claimedAt!.getTime()).toBeGreaterThanOrEqual(before)
    const claimed = (await allIntervals()).find(i => i.membershipId === "wm_imported")!
    expect(Date.parse(claimed.start)).toBeGreaterThanOrEqual(before)
    expect(claimed.start).not.toBe(importedAt.toISOString())
    expect(claimed.end).toBeNull()
  })

  test("a membership claimed before claimedAt existed starts at its membership.claimed event", async () => {
    const ws = await workspace()
    const claimEvent = new Date(Date.now() - 5 * DAY_MS)
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_legacy_claim",
        workspaceId: ws,
        mentraUserId: "mu_legacy",
        pendingWorkosUserId: null,
        email: "legacy@example.test",
        role: "member",
        status: "active",
        startedAt: new Date(Date.now() - 60 * DAY_MS),
      }),
    )
    await WorkspaceAuditEventModel.collection.insertOne({
      eventId: "evt_legacy_claim",
      seq: 9001,
      workspaceId: ws,
      action: "membership.claimed",
      occurredAt: claimEvent,
      target: {membershipId: "wm_legacy_claim", mentraUserId: "mu_legacy", email: "legacy@example.test"},
      before: {mentraUserId: null},
      after: {mentraUserId: "mu_legacy", role: "member"},
    })
    const found = (await allIntervals()).find(i => i.membershipId === "wm_legacy_claim")!
    expect(found.start).toBe(claimEvent.toISOString())
  })

  test("pages are stable: one cursor walks every membership once, and a row added mid-walk does not repeat one", async () => {
    const ws = await workspace()
    for (const id of ["mu_1", "mu_2", "mu_3", "mu_4", "mu_5"]) await member(ws, id, "member")
    const first = await listMembershipIntervals({limit: 2})
    expect(first.intervals).toHaveLength(2)
    expect(first.next).not.toBeNull()
    await member(ws, "mu_6", "member")
    const seen = new Set(first.intervals.map(i => i.membershipId))
    let after = first.next
    while (after) {
      const page = await listMembershipIntervals({after, limit: 2})
      for (const interval of page.intervals) {
        expect(seen.has(interval.membershipId)).toBe(false)
        seen.add(interval.membershipId)
      }
      after = page.next
    }
    expect(seen.size).toBe(7) // owner + six members, each once
  })

  test("feedSeq is the feed's head before the read", async () => {
    await workspace()
    const head = (await listMembershipIntervals({})).feedSeq
    expect(head).toBeGreaterThan(0)
    await WorkspaceAuditCounterModel.updateOne({}, {$inc: {seq: 3}})
    expect((await listMembershipIntervals({})).feedSeq).toBe(head + 3)
  })

  test("a bad cursor is a 400, and a limit is clamped", async () => {
    await workspace()
    const bad = await call(`${API}/membership-intervals?after=nonsense`)
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe("invalid_request")
    const clamped = await call(`${API}/membership-intervals?limit=100000`)
    expect(clamped.status).toBe(200)
  })
})

describe("the internal routes", () => {
  test("service fleet reads intervals, uncached; service store is refused", async () => {
    await workspace()
    const ok = await call(`${API}/membership-intervals?limit=10`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    expect(ok.json.intervals.length).toBeGreaterThan(0)
    expect(ok.json).toMatchObject({lookbackDays: 90, next: null})
    expect((await call(`${API}/membership-intervals`, "store")).status).toBe(403)
    expect((await call(`${API}/workspaces/${"ws_x"}/members`, "store")).status).toBe(403)
  })

  test("members: names where Core has them, null where it has none; pending included; oldest first", async () => {
    const ws = await workspace()
    await member(ws, "mu_named", "developer", {startedAt: new Date(Date.now() + 1000)})
    await member(ws, "mu_unnamed", "member", {startedAt: new Date(Date.now() + 2000)})
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: "wm_waiting",
        workspaceId: ws,
        mentraUserId: null,
        pendingWorkosUserId: "user_w",
        email: "waiting@example.test",
        role: "member",
        status: "active",
        startedAt: new Date(Date.now() + 3000),
      }),
    )
    for (const [id, name, signedAt] of [
      ["mu_owner", "Olivia Owner", new Date()],
      ["mu_named", "  Nora Named  ", new Date()],
      ["mu_unnamed", "   ", new Date()],
    ] as const) {
      await SigninIdentityModel.create({
        mentraUserId: id,
        tenantId: "mentra",
        sourceId: "mentra",
        subject: `sub-${id}`,
        email: `${id}@example.test`,
        emailVerified: true,
        name,
        signedInAt: signedAt,
      })
    }
    const res = await call(`${API}/workspaces/${ws}/members`)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const members = res.json.members as Array<{mentraUserId: string | null; name: string | null; email: string | null; pending: boolean}>
    expect(members.map(m => m.mentraUserId)).toEqual(["mu_owner", "mu_named", "mu_unnamed", null])
    expect(members.map(m => m.name)).toEqual(["Olivia Owner", "Nora Named", null, null])
    expect(members[3]).toMatchObject({pending: true, email: "waiting@example.test"})
    expect(members[2]!.email).toBe("mu_unnamed@example.test")
  })

  test("a name updates at the person's next sign-in", async () => {
    const ws = await workspace()
    await SigninIdentityModel.create({
      mentraUserId: "mu_owner", tenantId: "mentra", sourceId: "mentra", subject: "s", email: "o@example.test",
      emailVerified: true, name: "Before", signedInAt: new Date(),
    })
    expect((await toMemberViews(await listMembers(ws)))[0]!.name).toBe("Before")
    await SigninIdentityModel.updateOne({mentraUserId: "mu_owner"}, {$set: {name: "After"}})
    expect((await toMemberViews(await listMembers(ws)))[0]!.name).toBe("After")
  })

  test("an unknown or deleted workspace is 404", async () => {
    expect((await call(`${API}/workspaces/ws_missing/members`)).status).toBe(404)
    const ws = await workspace()
    await deleteWorkspace(owner, ws, {confirmName: "Acme"})
    expect((await call(`${API}/workspaces/${ws}/members`)).status).toBe(404)
  })

  test("without the fleet secret configured, Core refuses the call", async () => {
    process.env.CLOUD_CORE_SERVICE_SECRETS = JSON.stringify({store: ["store-s1"]})
    expect((await call(`${API}/membership-intervals`)).status).toBeGreaterThanOrEqual(401)
  })
})
