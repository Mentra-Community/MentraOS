/**
 * @fileoverview The workspace change feed: how audit events take their `seq`
 * (`recordWorkspaceEvent`) and how services read them (`listChanges`).
 *
 * The properties a poller depends on, against a real local replica set:
 *  - `seq` is issued from one counter inside the recording transaction, so it follows commit order,
 *    a rolled-back transaction gives its numbers back, and a transaction that starts while another
 *    holds the counter cannot take a number until that one has ended;
 *  - organization-level events (operator keys) are written without a transaction and take no `seq`;
 *  - events recorded before the feed existed have no `seq`, never appear in it and never disturb
 *    paging, whatever their position in the collection;
 *  - the `seq` index is not unique: Azure Cosmos DB cannot add a unique index to a collection that
 *    already holds documents, and `workspace_audit_events` always does.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name,
 * ignores `MONGO_URL`) and asserts the live connection is on that database before any destructive
 * call. The database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspace-change-feed.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import type {Model} from "mongoose"

import {connectMongo, disconnectMongo, withTransaction} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {
  WORKSPACE_AUDIT_COUNTER_ID,
  WorkspaceAuditCounterModel,
} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {runWithRequestId} from "../packages/core/src/services/request-context"
import {
  listChanges,
  recordOrganizationEvent,
  recordWorkspaceEvent,
  redactSecrets,
  type WorkspaceAuditEventInput,
} from "../packages/core/src/services/workspaces/audit.service"
import {ensureWorkspace} from "../packages/core/src/services/workspaces/automatic-workspace.service"
import {acceptInvitation, createInvitation} from "../packages/core/src/services/workspaces/invitation.service"
import {
  createWorkspace,
  renameWorkspace,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {USER_DELETED_ACTION} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS: Model<any>[] = [
  AccessCredentialModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false

const owner: Actor & {kind: "user"} = {
  kind: "user",
  mentraUserId: "mu_owner",
  email: "mu_owner@example.test",
  emailVerified: true,
  isOrganizationAdmin: false,
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspace-change-feed")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
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
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
})

// --- Fixtures --------------------------------------------------------------

function event(overrides: Partial<WorkspaceAuditEventInput> = {}): WorkspaceAuditEventInput {
  return {
    workspaceId: "ws_feed",
    action: "test.event",
    actor: {kind: "system"},
    target: {},
    ...overrides,
  }
}

/** Record `events` in one transaction and return their `seq`s, in order. */
async function recordAll(...events: WorkspaceAuditEventInput[]): Promise<number[]> {
  const ids = await withTransaction(async session => {
    const issued: string[] = []
    for (const next of events) issued.push(await recordWorkspaceEvent(session, next))
    return issued
  })
  return seqsOf(ids)
}

async function seqsOf(eventIds: string[]): Promise<number[]> {
  const rows = await WorkspaceAuditEventModel.find({eventId: {$in: eventIds}}).lean()
  return eventIds.map(id => rows.find(row => row.eventId === id)!.seq as number)
}

/** A document as an earlier Core wrote it: no `seq`, and an `eventId` the ULID source issued then. */
function legacyDocument(eventId: string, fields: Record<string, unknown> = {}) {
  return {
    eventId,
    workspaceId: "ws_feed",
    action: "membership.added",
    actor: {kind: "system"},
    target: {membershipId: "wm_old"},
    requestId: null,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...fields,
  }
}

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

async function expectInvalid(fn: () => Promise<unknown>) {
  const err = await thrown(fn)
  expect(err).toBeInstanceOf(WorkspaceError)
  expect({code: err.code, status: err.status}).toEqual({code: "invalid_request", status: 400})
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// --- Issuing seq -----------------------------------------------------------

describe("seq", () => {
  test("consecutive events take consecutive numbers from 1, in the order they were recorded", async () => {
    const first = await recordAll(event({action: "a"}), event({action: "b"}), event({action: "c"}))
    const second = await recordAll(event({action: "d"}))

    expect(first).toEqual([1, 2, 3])
    expect(second).toEqual([4])
    expect((await WorkspaceAuditCounterModel.findById(WORKSPACE_AUDIT_COUNTER_ID).lean())?.seq).toBe(4)
  })

  test("a rolled-back transaction gives its numbers back, so the committed sequence has no gaps", async () => {
    await recordAll(event({action: "kept_1"}))
    const failure = await thrown(() =>
      withTransaction(async session => {
        await recordWorkspaceEvent(session, event({action: "rolled_back_1"}))
        await recordWorkspaceEvent(session, event({action: "rolled_back_2"}))
        throw new Error("abort")
      }),
    )
    expect(failure.message).toBe("abort")
    const next = await recordAll(event({action: "kept_2"}))

    expect(next).toEqual([2])
    const rows = await WorkspaceAuditEventModel.find({}).sort({seq: 1}).lean()
    expect(rows.map(row => [row.seq, row.action])).toEqual([
      [1, "kept_1"],
      [2, "kept_2"],
    ])
  })

  test("a transaction that starts while another holds the counter cannot take a number before that one ends", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let holderHasNumber!: () => void
    const holderStarted = new Promise<void>(resolve => (holderHasNumber = resolve))

    const holder = withTransaction(async session => {
      const id = await recordWorkspaceEvent(session, event({action: "holder"}))
      holderHasNumber()
      await held
      return id
    })
    await holderStarted
    // The second recorder retries (the counter is taken) until the holder commits. It must not commit first.
    const waiter = withTransaction(session => recordWorkspaceEvent(session, event({action: "waiter"})))
    await sleep(300)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(0)

    release()
    const [holderId, waiterId] = await Promise.all([holder, waiter])

    expect(await seqsOf([holderId, waiterId])).toEqual([1, 2])
  })

  test("recorders racing on a new feed all get distinct numbers with no gap", async () => {
    const ids = await Promise.all(
      Array.from({length: 12}, (_, i) =>
        withTransaction(session => recordWorkspaceEvent(session, event({action: "race", target: {i}}))),
      ),
    )

    expect((await seqsOf(ids)).sort((a, b) => a - b)).toEqual(Array.from({length: 12}, (_, i) => i + 1))
    expect((await listChanges({limit: 500})).events.map(e => e.seq)).toEqual(Array.from({length: 12}, (_, i) => i + 1))
  })

  test("workspace mutations take their numbers in the order they committed", async () => {
    const created = await createWorkspace(owner, {name: "One"})
    await renameWorkspace(owner, created.workspaceId, "Two", 0)
    const other = await createWorkspace({...owner, mentraUserId: "mu_second_owner", email: "mu_second_owner@example.test"}, {name: "Three"})

    const {events} = await listChanges({})
    expect(events.map(e => [e.seq, e.workspaceId, e.action])).toEqual([
      [1, created.workspaceId, "workspace.created"],
      [2, created.workspaceId, "workspace.renamed"],
      [3, other.workspaceId, "workspace.created"],
    ])
  })

  test("an organization-level event takes no number and does not advance the counter", async () => {
    await recordAll(event({action: "first"}))
    await recordOrganizationEvent(event({workspaceId: null, action: "credential.created", actor: {kind: "system"}}))
    const [after] = await recordAll(event({action: "second"}))

    const organizational = await WorkspaceAuditEventModel.findOne({action: "credential.created"}).lean()
    expect(organizational).not.toBeNull()
    expect(organizational!.seq).toBeUndefined()
    expect(after).toBe(2)
    expect((await listChanges({})).events.map(e => e.action)).toEqual(["first", "second"])
  })

  test("the event records the request that caused it, and the caller's own request id wins", async () => {
    const [implicit] = await runWithRequestId("req_feed", () => recordAll(event({action: "implicit"})))
    const [explicit] = await runWithRequestId("req_feed", () => recordAll(event({action: "explicit", requestId: "req_own"})))

    expect(implicit).toBe(1)
    expect(explicit).toBe(2)
    const rows = await WorkspaceAuditEventModel.find({}).sort({seq: 1}).lean()
    expect(rows.map(row => row.requestId)).toEqual(["req_feed", "req_own"])
  })
})

// --- Events from before the feed -------------------------------------------

describe("events recorded before the feed existed", () => {
  test("have no seq, so none of them is ever listed, at any position in the collection", async () => {
    // Older and newer eventIds than the feed's own, written before and after them.
    await WorkspaceAuditEventModel.collection.insertMany([
      legacyDocument("01H00000000000000000000001"),
      legacyDocument("01H00000000000000000000002", {workspaceId: null, action: "credential.created"}),
    ])
    await recordAll(event({action: "feed_1"}), event({action: "feed_2"}))
    await WorkspaceAuditEventModel.collection.insertMany([
      legacyDocument("01ZZ00000000000000000000A1"),
      // A value that is not a number is not "after" anything either.
      legacyDocument("01ZZ00000000000000000000A2", {seq: null}),
      legacyDocument("01ZZ00000000000000000000A3", {seq: "7"}),
    ])

    const all = await listChanges({})

    expect(all.events.map(e => [e.seq, e.action])).toEqual([
      [1, "feed_1"],
      [2, "feed_2"],
    ])
    expect(all.next).toBeNull()
  })

  test("never break paging: a page boundary falls between feed events, not on a legacy one", async () => {
    await WorkspaceAuditEventModel.collection.insertMany([
      legacyDocument("01H00000000000000000000001"),
      legacyDocument("01H00000000000000000000002"),
    ])
    await recordAll(event({action: "a"}), event({action: "b"}), event({action: "c"}))
    await WorkspaceAuditEventModel.collection.insertMany([legacyDocument("01ZZ00000000000000000000A1")])

    const seen: string[] = []
    let after: string | null = null
    for (let page = 0; page < 5; page++) {
      const result = await listChanges({after, limit: 2})
      seen.push(...result.events.map(e => e.action))
      if (result.next === null) break
      after = result.next
    }

    expect(seen).toEqual(["a", "b", "c"])
  })

  test("a feed with only legacy events is empty", async () => {
    await WorkspaceAuditEventModel.collection.insertMany([legacyDocument("01H00000000000000000000001")])

    expect(await listChanges({})).toEqual({events: [], next: null})
    expect(await listChanges({after: "0", limit: 1})).toEqual({events: [], next: null})
  })

  test("the first event of a feed that already has history in its collection is number 1", async () => {
    await WorkspaceAuditEventModel.collection.insertMany([legacyDocument("01H00000000000000000000001")])

    expect(await recordAll(event())).toEqual([1])
  })
})

// --- Reading ---------------------------------------------------------------

describe("listChanges", () => {
  test("pages in seq order with a cursor, and next is null once a page is not full", async () => {
    await recordAll(...Array.from({length: 5}, (_, i) => event({action: `step_${i + 1}`})))

    const first = await listChanges({limit: 2})
    const second = await listChanges({after: first.next, limit: 2})
    const third = await listChanges({after: second.next, limit: 2})
    const beyond = await listChanges({after: third.events.at(-1)!.seq.toString(), limit: 2})

    expect(first.events.map(e => e.action)).toEqual(["step_1", "step_2"])
    expect(first.next).toBe("2")
    expect(second.events.map(e => e.action)).toEqual(["step_3", "step_4"])
    expect(second.next).toBe("4")
    expect(third.events.map(e => e.action)).toEqual(["step_5"])
    expect(third.next).toBeNull()
    expect(beyond).toEqual({events: [], next: null})
  })

  test("a page that is exactly full has a cursor, and the page after it is empty", async () => {
    await recordAll(event({action: "a"}), event({action: "b"}))

    const full = await listChanges({limit: 2})

    expect(full.next).toBe("2")
    expect(await listChanges({after: full.next, limit: 2})).toEqual({events: [], next: null})
  })

  test("after is exclusive, and absent, null and 0 all start from the beginning", async () => {
    await recordAll(event({action: "a"}), event({action: "b"}), event({action: "c"}))

    const fromTwo = await listChanges({after: "2"})

    expect(fromTwo.events.map(e => e.action)).toEqual(["c"])
    for (const start of [{}, {after: null}, {after: "0"}]) {
      expect((await listChanges(start)).events.map(e => e.action)).toEqual(["a", "b", "c"])
    }
  })

  test("a cursor that is not a sequence number is invalid_request", async () => {
    for (const after of ["", " ", "-1", "1.5", "1e3", "abc", "01", "0x10", "+1", "2 ", "9007199254740993", "NaN"]) {
      await expectInvalid(() => listChanges({after}))
    }
  })

  test("the page size defaults to 100 and is clamped to between 1 and 500", async () => {
    const docs = Array.from({length: 600}, (_, i) => legacyDocument(`01J${String(i).padStart(23, "0")}`, {seq: i + 1}))
    await WorkspaceAuditEventModel.collection.insertMany(docs)

    expect((await listChanges({})).events).toHaveLength(100)
    expect((await listChanges({limit: 10_000})).events).toHaveLength(500)
    expect((await listChanges({limit: 500})).events).toHaveLength(500)
    expect((await listChanges({limit: 501})).events).toHaveLength(500)
    expect((await listChanges({limit: 0})).events).toHaveLength(1)
    expect((await listChanges({limit: -4})).events).toHaveLength(1)
    expect((await listChanges({limit: 1.9})).events).toHaveLength(1)
    expect((await listChanges({limit: Number.NaN})).events).toHaveLength(1)
    const big = await listChanges({after: "100", limit: 10_000})
    expect(big.events[0]!.seq).toBe(101)
    expect(big.events).toHaveLength(500)
    expect(big.next).toBe("600")
  })

  test("lists workspace events and user.deleted tombstones, and leaves every other workspace-less event out", async () => {
    await recordAll(
      event({action: "workspace.created"}),
      event({workspaceId: null, action: "credential.revoked"}),
      event({workspaceId: null, action: USER_DELETED_ACTION, target: {mentraUserId: "mu_gone"}}),
      event({action: "membership.added"}),
    )

    const {events, next} = await listChanges({})

    expect(events.map(e => [e.seq, e.workspaceId, e.action])).toEqual([
      [1, "ws_feed", "workspace.created"],
      [3, null, USER_DELETED_ACTION],
      [4, "ws_feed", "membership.added"],
    ])
    expect(next).toBeNull()
  })

  test("an event is its ids, workspace, action, time and snapshots, never the actor or the request", async () => {
    await runWithRequestId("req_hidden", () =>
      recordAll(
        event({
          action: "membership.role_changed",
          actor: {kind: "user", mentraUserId: "mu_actor", email: "actor@example.test"},
          target: {membershipId: "wm_1", mentraUserId: "mu_1"},
          before: {role: "member"},
          after: {role: "admin"},
        }),
        event({action: "no.snapshots", target: undefined}),
      ),
    )

    const {events} = await listChanges({})

    expect(Object.keys(events[0]!).sort()).toEqual(
      ["action", "after", "before", "eventId", "occurredAt", "seq", "target", "workspaceId"].sort(),
    )
    expect(events[0]).toEqual({
      eventId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      seq: 1,
      workspaceId: "ws_feed",
      action: "membership.role_changed",
      occurredAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      target: {membershipId: "wm_1", mentraUserId: "mu_1"},
      before: {role: "member"},
      after: {role: "admin"},
    })
    expect(JSON.stringify(events)).not.toContain("mu_actor")
    expect(JSON.stringify(events)).not.toContain("req_hidden")
    // A change with no snapshot reads as null, not as an empty object that looks like one.
    expect(events[1]).toMatchObject({action: "no.snapshots", target: null, before: null, after: null})
  })

  test("credential-looking keys are removed from target, before and after at any depth", async () => {
    await recordAll(
      event({
        action: "credential.created",
        target: {
          credentialId: "c_1",
          token: "msk_local_x.y",
          nested: {deep: {secret: "s", keep: 1, list: [{passwordHint: "p", name: "ok"}, "plain", 7]}},
        },
        before: {Token: "t", tokenHash: "h", apiSecretKey: "k", role: "member"},
        after: {
          rows: [{hash: "h1", id: 1}, {hashes: ["a"], id: 2}],
          deeper: {one: {two: {three: {PASSWORD: "x", fine: true}}}},
          when: new Date("2026-02-03T04:05:06.000Z"),
        },
      }),
    )

    const [feed] = (await listChanges({})).events
    const text = JSON.stringify(feed)

    for (const secret of ["msk_local", "tokenHash", "Token", "apiSecretKey", "passwordHint", "PASSWORD", "hashes", '"hash"']) {
      expect(text).not.toContain(secret)
    }
    expect(feed!.target).toEqual({
      credentialId: "c_1",
      nested: {deep: {keep: 1, list: [{name: "ok"}, "plain", 7]}},
    })
    expect(feed!.before).toEqual({role: "member"})
    expect(feed!.after).toEqual({
      rows: [{id: 1}, {id: 2}],
      deeper: {one: {two: {three: {fine: true}}}},
      when: new Date("2026-02-03T04:05:06.000Z"),
    })
    // The stored event is untouched: redaction is a property of what leaves Core, not of the trail.
    expect((await WorkspaceAuditEventModel.findOne({action: "credential.created"}).lean())!.target).toMatchObject({
      token: "msk_local_x.y",
    })
  })

  test("redactSecrets leaves values that are not records alone and does not touch its input", () => {
    const input = {token: "t", list: [{secret: 1, keep: [{hash: 2, ok: 3}]}], when: new Date(0), nothing: null}

    expect(redactSecrets(input)).toEqual({list: [{keep: [{ok: 3}]}], when: new Date(0), nothing: null})
    expect(input.token).toBe("t")
    expect(redactSecrets("token")).toBe("token")
    expect(redactSecrets(null)).toBeNull()
    expect(redactSecrets(7)).toBe(7)
  })
})

// --- Giving way ------------------------------------------------------------

describe("an empty automatic workspace giving way", () => {
  const TEMPLATE = "CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE"

  /** `mu_newcomer` with an automatic workspace, and an invitation from `mu_owner` to join "Acme" as a member. */
  async function setUp() {
    const saved = process.env[TEMPLATE]
    process.env[TEMPLATE] = "https://core.example.test/invite/{token}"
    try {
      await UserModel.create([
        {mentraUserId: "mu_newcomer", tenantId: "mentra", tenantUserId: "sb-newcomer"},
        {mentraUserId: "mu_owner", tenantId: "mentra", tenantUserId: "sb-owner"},
      ])
      const newcomer: Actor & {kind: "user"} = {
        kind: "user",
        mentraUserId: "mu_newcomer",
        email: "newcomer@example.test",
        emailVerified: true,
        isOrganizationAdmin: false,
      }
      const automatic = (await ensureWorkspace(newcomer)).workspace.workspaceId
      const acme = await createWorkspace(owner, {name: "Acme"})
      const invitation = await createInvitation(owner, acme.workspaceId, {email: "newcomer@example.test", role: "member"})
      return {newcomer, automatic, acme: acme.workspaceId, token: invitation.inviteUrl.split("/invite/")[1]!}
    } finally {
      if (saved === undefined) delete process.env[TEMPLATE]
      else process.env[TEMPLATE] = saved
    }
  }

  test("the deletion and the join are both on the feed, in one run of consecutive numbers", async () => {
    const {newcomer, automatic, acme, token} = await setUp()
    const before = (await listChanges({})).events.at(-1)!.seq

    await acceptInvitation(newcomer, token)

    const added = (await listChanges({after: String(before)})).events
    expect(added.map(e => [e.workspaceId, e.action])).toEqual([
      [automatic, "workspace.deleted"],
      [acme, "invitation.accepted"],
      [acme, "membership.added"],
    ])
    expect(added.map(e => e.seq)).toEqual([before + 1, before + 2, before + 3])
    expect(added[0]!.after).toMatchObject({status: "deleted", reason: "joined_another_workspace"})
  })

  test("an aborted accept leaves neither change on the feed and its numbers are reused", async () => {
    const {newcomer, automatic, token} = await setUp()
    const before = (await listChanges({})).events.at(-1)!.seq
    const create = spyOn(WorkspaceMembershipModel, "create").mockRejectedValueOnce(new Error("forced failure"))
    try {
      await expect(acceptInvitation(newcomer, token)).rejects.toThrow("forced failure")
    } finally {
      create.mockRestore()
    }

    expect((await listChanges({after: String(before)})).events).toEqual([])
    expect((await WorkspaceModel.findOne({workspaceId: automatic}).lean())!.status).toBe("active")
    await acceptInvitation(newcomer, token)
    expect((await listChanges({after: String(before)})).events.map(e => e.seq)).toEqual([
      before + 1,
      before + 2,
      before + 3,
    ])
  })
})

// --- The index -------------------------------------------------------------

describe("the seq index", () => {
  test("is a plain index: a second event may share a number", async () => {
    const indexes = await WorkspaceAuditEventModel.collection.indexes()
    const seqIndex = indexes.find(index => JSON.stringify(index.key) === JSON.stringify({seq: 1}))

    expect(seqIndex).toBeDefined()
    expect(seqIndex!.unique).not.toBe(true)
    // Nothing forbids it, so a database that cannot build a unique index on a populated collection still builds this one.
    await WorkspaceAuditEventModel.collection.insertMany([
      legacyDocument("01K00000000000000000000001", {seq: 9}),
      legacyDocument("01K00000000000000000000002", {seq: 9}),
    ])
    expect(await WorkspaceAuditEventModel.countDocuments({seq: 9})).toBe(2)
  })

  test("the counter is one document with a fixed id, created on first use", async () => {
    expect(await WorkspaceAuditCounterModel.countDocuments({})).toBe(0)

    await recordAll(event())

    const counters = await WorkspaceAuditCounterModel.find({}).lean()
    expect(counters).toHaveLength(1)
    expect(counters[0]).toMatchObject({_id: WORKSPACE_AUDIT_COUNTER_ID, seq: 1})
  })
})
