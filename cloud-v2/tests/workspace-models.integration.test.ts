/**
 * @fileoverview Workspace models, local-only test Mongo guard, and `withTransaction`.
 *
 * The `localTestMongoUrl` guard tests run without Mongo. The model and
 * transaction tests need a local replica set (transactions require one).
 *
 * Safety: the model tests connect through `localTestMongoUrl` (loopback only,
 * random database name, ignores `MONGO_URL`) and assert the live connection is
 * on that database before any destructive call, so this file can never touch a
 * shared or live database. The database is dropped in `afterAll`, only if the
 * check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspace-models.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import type {Model} from "mongoose"

import {
  connectMongo,
  disconnectMongo,
  isCrossCollectionTransactionUnsupported,
  isTransactionsUnsupportedError,
  withTransaction,
} from "../packages/core/src/connections/mongo.connection"
import {runStartupMigrations} from "../packages/core/src/migrations/startup.migrations"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {LegacyBrowserIdentityModel} from "../packages/core/src/models/legacy-browser-identity.model"
import {
  WORKSPACE_AUDIT_COUNTER_ID,
  WorkspaceAuditCounterModel,
} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

const MODELS: Model<any>[] = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
  LegacyBrowserIdentityModel,
]

/** Run `fn` and return whatever it throws (fails the test if it does not throw). */
async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

describe("localTestMongoUrl guard", () => {
  const saved = {
    base: process.env.CLOUD_V2_TEST_MONGO_URL,
    legacy: process.env.MONGO_URL,
  }

  afterEach(() => {
    if (saved.base === undefined) delete process.env.CLOUD_V2_TEST_MONGO_URL
    else process.env.CLOUD_V2_TEST_MONGO_URL = saved.base
    if (saved.legacy === undefined) delete process.env.MONGO_URL
    else process.env.MONGO_URL = saved.legacy
  })

  function withBase(url: string): string {
    process.env.CLOUD_V2_TEST_MONGO_URL = url
    return localTestMongoUrl("guard")
  }

  test("rejects SRV (Atlas) URLs", () => {
    expect(() => withBase("mongodb+srv://x.mongodb.net")).toThrow()
  })

  test("rejects URLs that carry credentials", () => {
    expect(() => withBase("mongodb://user:pw@127.0.0.1")).toThrow()
    expect(() => withBase("mongodb://user@127.0.0.1:27017")).toThrow()
  })

  test("rejects non-loopback hosts", () => {
    expect(() => withBase("mongodb://10.0.0.5:27017")).toThrow()
    expect(() => withBase("mongodb://db.example.com:27017")).toThrow()
    expect(() => withBase("mongodb://0.0.0.0:27017")).toThrow()
    expect(() => withBase("mongodb://127.0.0.1.evil.test:27017")).toThrow()
    expect(() => withBase("mongodb://localhost.evil.test:27017")).toThrow()
  })

  test("rejects multi-host seed lists, unparseable URLs, and other schemes", () => {
    expect(() => withBase("mongodb://127.0.0.1:27017,10.0.0.5:27017")).toThrow()
    expect(() => withBase("mongodb://127.0.0.1:notaport")).toThrow()
    expect(() => withBase("not a url")).toThrow()
    expect(() => withBase("http://127.0.0.1:27017")).toThrow()
  })

  test("rejects a base URL that already names a database or options", () => {
    expect(() => withBase("mongodb://127.0.0.1:27017/mentra-prod")).toThrow()
    expect(() => withBase("mongodb://127.0.0.1:27017/?authSource=admin")).toThrow()
  })

  test("rejects unsafe or empty database prefixes", () => {
    process.env.CLOUD_V2_TEST_MONGO_URL = "mongodb://127.0.0.1:27017"
    expect(() => localTestMongoUrl("")).toThrow()
    expect(() => localTestMongoUrl("a/b")).toThrow()
    expect(() => localTestMongoUrl("a.b")).toThrow()
    expect(() => localTestMongoUrl("a".repeat(41))).toThrow()
  })

  test("accepts loopback hosts and returns a random database with directConnection", () => {
    const first = withBase("mongodb://127.0.0.1:27031")
    expect(first).toMatch(/^mongodb:\/\/127\.0\.0\.1:27031\/guard-[0-9a-f]{12}\?directConnection=true$/)
    expect(withBase("mongodb://localhost:27031/")).toMatch(
      /^mongodb:\/\/localhost:27031\/guard-[0-9a-f]{12}\?directConnection=true$/,
    )
    expect(withBase("mongodb://127.0.0.1:27031")).not.toBe(first)
  })

  test("defaults to the local compose Mongo when unset", () => {
    delete process.env.CLOUD_V2_TEST_MONGO_URL
    expect(localTestMongoUrl("guard")).toMatch(
      /^mongodb:\/\/127\.0\.0\.1:27017\/guard-[0-9a-f]{12}\?directConnection=true$/,
    )
  })

  test("ignores MONGO_URL entirely", () => {
    process.env.MONGO_URL = "mongodb://10.0.0.5:27017/prod"
    process.env.CLOUD_V2_TEST_MONGO_URL = "mongodb://127.0.0.1:27031"
    expect(localTestMongoUrl("guard")).toStartWith("mongodb://127.0.0.1:27031/guard-")
    delete process.env.CLOUD_V2_TEST_MONGO_URL
    expect(localTestMongoUrl("guard")).toStartWith("mongodb://127.0.0.1:27017/guard-")
  })
})

describe("assertConnectedTo guard", () => {
  const url = "mongodb://127.0.0.1:27031/workspace-models-0123456789ab?directConnection=true"

  test("passes only for the database named in the URL", () => {
    expect(() => assertConnectedTo(url, "workspace-models-0123456789ab")).not.toThrow()
    expect(() => assertConnectedTo(url, "mentra-cloud-v2-test")).toThrow(/refusing destructive test calls/)
    expect(() => assertConnectedTo(url, "")).toThrow()
    expect(() => assertConnectedTo(url, "workspace-models-0123456789ac")).toThrow()
  })

  test("refuses a URL that names no database", () => {
    expect(() => assertConnectedTo("mongodb://127.0.0.1:27031/", "")).toThrow()
    expect(() => assertConnectedTo("mongodb://127.0.0.1:27031", "test")).toThrow()
  })
})

describe("withTransaction (error mapping, no Mongo)", () => {
  test("maps a server without transaction support to an error naming the replica-set requirement", async () => {
    let ended = false
    const serverError = Object.assign(
      new Error("Transaction numbers are only allowed on a replica set member or mongos"),
      {code: 20, codeName: "IllegalOperation"},
    )
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw serverError
      },
      endSession: async () => {
        ended = true
      },
    } as any)
    try {
      const err = await thrown(() => withTransaction(async () => "unreachable"))
      expect(err.message).toMatch(/replica set/i)
      expect(err.cause).toBe(serverError)
      expect(ended).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test("maps the driver's topology-compatibility error", async () => {
    const compat = Object.assign(new Error("Current topology does not support sessions"), {
      name: "MongoCompatibilityError",
    })
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw compat
      },
      endSession: async () => {},
    } as any)
    try {
      const err = await thrown(() => withTransaction(async () => 1))
      expect(err.message).toMatch(/replica set/i)
      expect(err.cause).toBe(compat)
    } finally {
      spy.mockRestore()
    }
  })

  test("does not reclassify errors that only resemble the unsupported-transactions failure", async () => {
    const lookalikes = [
      new Error("this feature does not support transactions"),
      Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), {code: 11000}),
      Object.assign(new Error("some other illegal operation"), {code: 20}),
      Object.assign(new Error("Current topology does not support sessions"), {name: "SomeOtherError"}),
    ]
    for (const lookalike of lookalikes) {
      const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
        withTransaction: async () => {
          throw lookalike
        },
        endSession: async () => {},
      } as any)
      try {
        expect(await thrown(() => withTransaction(async () => 1))).toBe(lookalike)
      } finally {
        spy.mockRestore()
      }
    }
  })

  test("isTransactionsUnsupportedError tells a deployment that cannot run transactions from one that failed", () => {
    const standalone = Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), {
      code: 20,
    })
    const wrapped = new Error("MongoDB transactions require a replica set", {cause: standalone})
    const compat = Object.assign(new Error("Current topology does not support sessions"), {name: "MongoCompatibilityError"})

    // The original failure, and `withTransaction`'s wrapper of it (the cause).
    for (const unsupported of [standalone, wrapped, compat, new Error("outer", {cause: wrapped})]) {
      expect(isTransactionsUnsupportedError(unsupported)).toBe(true)
    }
    // Everything else, transient or not, is a failure of this attempt.
    const transient = Object.assign(new Error("write conflict"), {errorLabels: ["TransientTransactionError"], code: 112})
    const unknownCommit = Object.assign(new Error("commit result unknown"), {errorLabels: ["UnknownTransactionCommitResult"]})
    const timeout = Object.assign(new Error("operation exceeded time limit"), {code: 50})
    const lookalike = Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), {code: 11000})
    for (const failed of [
      transient,
      unknownCommit,
      timeout,
      lookalike,
      new Error("connection closed"),
      new Error("outer", {cause: transient}),
      "Transaction numbers are only allowed on a replica set member or mongos",
      null,
      undefined,
    ]) {
      expect(isTransactionsUnsupportedError(failed)).toBe(false)
    }
  })

  describe("Azure Cosmos DB for MongoDB's refusal of a transaction across collections", () => {
    const cosmosMessage =
      "Error=2, Details='Response status code does not indicate success: BadRequest (400); Substatus: 1101; " +
      'ActivityId: 0b9d3a52-6a38-4f0e-9c1d-5c0e3f8a7e21; Reason: (Message: {"Errors":["Transaction is not active"]}\r\n' +
      "ActivityId: 0b9d3a52-6a38-4f0e-9c1d-5c0e3f8a7e21, Request URI: /apps/.../partitions/..., RequestStats: ...)'"
    const cosmos = (fields: Record<string, unknown> = {}) =>
      new (WorkspaceModel.base.mongo.MongoServerError)({message: cosmosMessage, code: 2, errorLabels: [], ...fields})

    test("is recognized by its code and both parts of its text, on the error or its cause", () => {
      const refused = cosmos()
      expect(refused.name).toBe("MongoServerError")
      expect(refused.hasErrorLabel("TransientTransactionError")).toBe(false)

      for (const recognized of [refused, new Error("outer", {cause: refused})]) {
        expect(isCrossCollectionTransactionUnsupported(recognized)).toBe(true)
      }
    })

    test("is nothing broader: another code, half the text, another class, or a non-error is not it", () => {
      for (const other of [
        cosmos({code: 112}),
        cosmos({code: undefined}),
        cosmos({message: "BadValue: unknown operator"}),
        cosmos({message: "Error=2, Details='Transaction is not active'"}),
        cosmos({message: "Error=2, Details='BadRequest (400); Substatus: 1101'"}),
        cosmos({errorLabels: ["TransientTransactionError"], code: 112, message: "write conflict"}),
        Object.assign(new Error(cosmosMessage), {code: 2}),
        new Error("outer", {cause: Object.assign(new Error(cosmosMessage), {code: 2})}),
        new Error("connection closed"),
        cosmosMessage,
        null,
        undefined,
      ]) {
        expect(isCrossCollectionTransactionUnsupported(other)).toBe(false)
      }
    })

    test("is not what withTransaction rewraps as a replica-set requirement: the workspace writes see Cosmos' own error", async () => {
      const refused = cosmos()
      expect(isTransactionsUnsupportedError(refused)).toBe(false)
      const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
        withTransaction: async () => {
          throw refused
        },
        endSession: async () => {},
      } as any)
      try {
        expect(await thrown(() => withTransaction(async () => 1))).toBe(refused)
      } finally {
        spy.mockRestore()
      }
    })
  })

  test("rethrows unrelated errors unchanged and still ends the session", async () => {
    let ended = false
    const boom = new Error("boom")
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw boom
      },
      endSession: async () => {
        ended = true
      },
    } as any)
    try {
      expect(await thrown(() => withTransaction(async () => 1))).toBe(boom)
      expect(ended).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("workspace models (local replica set)", () => {
  let databaseUrl: string
  // Set only once the live connection is confirmed to be on our random database;
  // every destructive call below is gated on it.
  let verified = false

  beforeAll(async () => {
    databaseUrl = localTestMongoUrl("workspace-models")
    await connectMongo(databaseUrl)
    // `connectMongo` ignores a second connect, so a connection leaked by another
    // test file would silently win. Fail before touching any data in that case.
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    verified = true
    // Startup migrations are not run here, so build each collection and its indexes.
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

  const membership = (overrides: Record<string, unknown> = {}) =>
    membershipRow({
      membershipId: `wm_${Math.random().toString(36).slice(2)}`,
      workspaceId: "ws_1",
      mentraUserId: "mu_1",
      role: "member",
      startedAt: new Date(),
      ...overrides,
    } as {role: string; startedAt: Date})

  const end = (membershipId: string, endedReason = "removed") =>
    WorkspaceMembershipModel.updateOne({membershipId}, {$set: {status: "ended", endedAt: new Date(), endedReason}})

  describe("workspaces", () => {
    test("applies defaults and timestamps", async () => {
      const row = await WorkspaceModel.create({workspaceId: "ws_1", name: "Acme"})
      expect(row.status).toBe("active")
      expect(row.authorizationRevision).toBe(0)
      expect(row.createdByMentraUserId).toBeNull()
      expect(row.deletedAt).toBeNull()
      expect(row.createdAt).toBeInstanceOf(Date)
      expect(row.updatedAt).toBeInstanceOf(Date)
    })

    test("enforces a unique workspaceId and the status enum", async () => {
      await WorkspaceModel.create({workspaceId: "ws_1", name: "A"})
      expect((await thrown(() => WorkspaceModel.create({workspaceId: "ws_1", name: "B"}))).code).toBe(11000)
      const invalid = await thrown(() => WorkspaceModel.create({workspaceId: "ws_2", name: "C", status: "archived"}))
      expect(invalid.name).toBe("ValidationError")
    })
  })

  describe("workspace memberships", () => {
    test("rejects a second active membership for the same workspace and user (E11000)", async () => {
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_a"}))
      const err = await thrown(() => WorkspaceMembershipModel.create(membership({membershipId: "wm_b"})))
      expect(err.code).toBe(11000)
      // Whatever the second row's role: the rule is one active membership per person, not per role.
      const owner = await thrown(() =>
        WorkspaceMembershipModel.create(membership({membershipId: "wm_c", role: "owner"})),
      )
      expect(owner.code).toBe(11000)
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: "ws_1", mentraUserId: "mu_1"})).toBe(1)
    })

    test("ended rows accumulate as history: each new generation is allowed once the previous one ended", async () => {
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_a"}))
      await end("wm_a", "removed")
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_b"}))
      await end("wm_b", "left")
      const next = await WorkspaceMembershipModel.create(membership({membershipId: "wm_c"}))
      expect(next.status).toBe("active")

      const rows = await WorkspaceMembershipModel.find({workspaceId: "ws_1", mentraUserId: "mu_1"})
        .sort({_id: 1})
        .lean()
      expect(rows.map(row => [row.membershipId, row.status, row.endedReason])).toEqual([
        ["wm_a", "ended", "removed"],
        ["wm_b", "ended", "left"],
        ["wm_c", "active", null],
      ])
      // Still only one active row: a fourth active generation is refused.
      expect((await thrown(() => WorkspaceMembershipModel.create(membership({membershipId: "wm_d"})))).code).toBe(11000)
    })

    test("an ended row cannot be reactivated while the person has another active membership", async () => {
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_a"}))
      await end("wm_a")
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_b"}))

      const err = await thrown(() =>
        WorkspaceMembershipModel.updateOne(
          {membershipId: "wm_a"},
          {$set: {status: "active", endedAt: null, endedReason: null}},
        ),
      )
      expect(err.code).toBe(11000)
      expect((await WorkspaceMembershipModel.findOne({membershipId: "wm_a"}).lean())!.status).toBe("ended")
    })

    test("concurrent inserts of an active membership for one person: exactly one wins", async () => {
      const results = await Promise.allSettled(
        Array.from({length: 5}, (_, i) => WorkspaceMembershipModel.create(membership({membershipId: `wm_race_${i}`}))),
      )
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      for (const result of results) {
        if (result.status === "rejected") expect((result.reason as {code?: number}).code).toBe(11000)
      }
      expect(
        await WorkspaceMembershipModel.countDocuments({workspaceId: "ws_1", mentraUserId: "mu_1", status: "active"}),
      ).toBe(1)
    })

    test("scopes uniqueness to the workspace and the person", async () => {
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_a"}))
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_b", workspaceId: "ws_2"}))
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_c", mentraUserId: "mu_2"}))
      expect(await WorkspaceMembershipModel.countDocuments({status: "active"})).toBe(3)
    })

    test("the active-membership index is unique and partial on active rows with a string user id", async () => {
      const indexes = await WorkspaceMembershipModel.collection.indexes()
      const byKey = (key: Record<string, number>) =>
        indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key))
      const active = byKey({workspaceId: 1, mentraUserId: 1})
      expect(active?.unique).toBe(true)
      expect(active?.partialFilterExpression).toEqual({status: "active", mentraUserId: {$type: "string"}})
      // The lookups the services use are indexed too.
      expect(byKey({mentraUserId: 1, status: 1})).toBeDefined()
      expect(byKey({workspaceId: 1, role: 1, status: 1})).toBeDefined()
      // The claim at first sign-in finds a WorkOS user's pending rows. The index is not unique: Azure
      // Cosmos DB cannot add a unique index to a populated collection, so the import enforces one pending
      // row per person per workspace itself.
      const pending = byKey({pendingWorkosUserId: 1, status: 1})
      expect(pending).toBeDefined()
      expect(pending?.unique).toBeUndefined()
      expect(indexes.filter(index => index.unique && "pendingWorkosUserId" in index.key)).toEqual([])
    })

    test("needs a Core user or a pending WorkOS user, and keeps only the fields it defines", async () => {
      for (const mentraUserId of [null, undefined, ""]) {
        const err = await thrown(() =>
          WorkspaceMembershipModel.create(membership({membershipId: `wm_${String(mentraUserId)}`, mentraUserId})),
        )
        expect(err.name).toBe("ValidationError")
      }
      expect(
        (await thrown(() =>
          WorkspaceMembershipModel.create(membership({membershipId: "wm_blank", mentraUserId: null, pendingWorkosUserId: " "})),
        )).name,
      ).toBe("ValidationError")
      // Memberships carry no display name. A row a Core mutation creates has no pending id at all.
      const row = await WorkspaceMembershipModel.create(membership({membershipId: "wm_a", name: "Ada"}))
      const stored = await WorkspaceMembershipModel.findOne({membershipId: row.membershipId}).lean()
      expect(stored).not.toHaveProperty("name")
      expect(stored).not.toHaveProperty("pendingWorkosUserId")
    })

    test("a membership imported from the Store waits for its person under their WorkOS user id", async () => {
      const pending = await WorkspaceMembershipModel.create(
        membership({membershipId: "wm_pending_a", mentraUserId: null, pendingWorkosUserId: "user_01A"}),
      )
      expect(pending.mentraUserId).toBeNull()
      expect(pending.pendingWorkosUserId).toBe("user_01A")
      // Pending rows never meet the one-active-membership index, which only covers string user ids.
      await WorkspaceMembershipModel.create(
        membership({membershipId: "wm_pending_b", mentraUserId: null, pendingWorkosUserId: "user_01B"}),
      )
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_claimed"}))
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: "ws_1", status: "active"})).toBe(3)
    })

    test("applies defaults and validates role and endedReason", async () => {
      const row = await WorkspaceMembershipModel.create(membership({membershipId: "wm_a", role: "owner"}))
      expect(row.status).toBe("active")
      expect(row.endedAt).toBeNull()
      expect(row.endedReason).toBeNull()
      expect(row.email).toBeNull()
      const invalid = [
        {membershipId: "wm_b", mentraUserId: "mu_9", role: "superuser"},
        {membershipId: "wm_c", mentraUserId: "mu_8", status: "ended", endedReason: "bogus"},
        {membershipId: "wm_d", mentraUserId: "mu_7", status: "paused"},
      ]
      for (const fields of invalid) {
        expect((await thrown(() => WorkspaceMembershipModel.create(membership(fields)))).name).toBe("ValidationError")
      }
      for (const role of ["owner", "admin", "developer", "member"]) {
        await WorkspaceMembershipModel.create(
          membership({membershipId: `wm_${role}`, mentraUserId: `mu_${role}`, role}),
        )
      }
      for (const endedReason of ["removed", "left", "workspace_deleted", "account_deleted"]) {
        await WorkspaceMembershipModel.create(
          membership({
            membershipId: `wm_${endedReason}`,
            mentraUserId: `mu_${endedReason}`,
            status: "ended",
            endedAt: new Date(),
            endedReason,
          }),
        )
      }
    })

    test("requires a role history of valid entries, and keeps it in order", async () => {
      const missing = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({membershipId: "wm_none", mentraUserId: "mu_none", roleHistory: []}),
        ),
      )
      expect(missing.name).toBe("ValidationError")
      const badRole = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({
            membershipId: "wm_bad",
            mentraUserId: "mu_bad",
            roleHistory: [{role: "superuser", from: new Date(), authorizationRevision: 0}],
          }),
        ),
      )
      expect(badRole.name).toBe("ValidationError")
      const noRevision = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({
            membershipId: "wm_norev",
            mentraUserId: "mu_norev",
            roleHistory: [{role: "member", from: new Date()}],
          }),
        ),
      )
      expect(noRevision.name).toBe("ValidationError")
      const noFrom = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({
            membershipId: "wm_nofrom",
            mentraUserId: "mu_nofrom",
            roleHistory: [{role: "member", authorizationRevision: 0}],
          }),
        ),
      )
      expect(noFrom.name).toBe("ValidationError")

      const first = new Date("2026-01-01T00:00:00.000Z")
      const second = new Date("2026-02-01T00:00:00.000Z")
      await WorkspaceMembershipModel.create(
        membership({
          membershipId: "wm_ok",
          role: "admin",
          startedAt: first,
          roleHistory: [
            {role: "member", from: first, authorizationRevision: 1},
            {role: "admin", from: second, authorizationRevision: 4},
          ],
        }),
      )
      const row = await WorkspaceMembershipModel.findOne({membershipId: "wm_ok"}).lean()
      expect(row!.roleHistory as unknown).toEqual([
        {role: "member", from: first, authorizationRevision: 1},
        {role: "admin", from: second, authorizationRevision: 4},
      ])
    })
  })

  describe("workspace invitations", () => {
    const invitation = (overrides: Record<string, unknown> = {}) => ({
      invitationId: `winv_${Math.random().toString(36).slice(2)}`,
      workspaceId: "ws_1",
      email: "Dev@Example.com",
      role: "developer",
      tokenHash: "hash",
      invitedByAuthority: "system",
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    })

    test("lowercases email, defaults to pending, and validates role", async () => {
      const row = await WorkspaceInvitationModel.create(invitation())
      expect(row.email).toBe("dev@example.com")
      expect(row.status).toBe("pending")
      expect(row.invitedByMembershipId).toBeNull()
      expect(row.invitedByMentraUserId).toBeNull()
      expect(row.invitedByEmail).toBeNull()
      expect(row.acceptedMembershipId).toBeNull()
      const invalid = await thrown(() =>
        WorkspaceInvitationModel.create(invitation({email: "x@example.com", role: "root"})),
      )
      expect(invalid.name).toBe("ValidationError")
    })

    test("requires the inviter's authority: membership, organization_admin or system", async () => {
      for (const invitedByAuthority of ["membership", "organization_admin", "system"]) {
        await WorkspaceInvitationModel.create(invitation({email: `${invitedByAuthority}@example.com`, invitedByAuthority}))
      }
      for (const invitedByAuthority of [undefined, "service"]) {
        const invalid = await thrown(() =>
          WorkspaceInvitationModel.create(invitation({email: `bad-${invitedByAuthority}@example.com`, invitedByAuthority})),
        )
        expect({invitedByAuthority, name: invalid.name, path: Object.keys(invalid.errors ?? {})}).toEqual({
          invitedByAuthority,
          name: "ValidationError",
          path: ["invitedByAuthority"],
        })
      }
    })

    test("allows one pending invitation per workspace and email", async () => {
      await WorkspaceInvitationModel.create(invitation({invitationId: "winv_a"}))
      const duplicate = await thrown(() =>
        WorkspaceInvitationModel.create(invitation({invitationId: "winv_b", email: "dev@example.com"})),
      )
      expect(duplicate.code).toBe(11000)
      await WorkspaceInvitationModel.create(invitation({invitationId: "winv_c", workspaceId: "ws_2"}))
      await WorkspaceInvitationModel.updateOne({invitationId: "winv_a"}, {$set: {status: "revoked"}})
      await WorkspaceInvitationModel.create(invitation({invitationId: "winv_d"}))
      await WorkspaceInvitationModel.updateOne({invitationId: "winv_d"}, {$set: {status: "accepted"}})
      await WorkspaceInvitationModel.create(invitation({invitationId: "winv_e"}))
    })
  })

  describe("access credentials", () => {
    test("stores workspace and organization credentials with null defaults", async () => {
      const workspaceKey = await AccessCredentialModel.create({
        credentialId: "01HZ0000000000000000000001",
        prefix: "msk",
        credentialKind: "workspace",
        workspaceId: "ws_1",
        name: "ci",
        env: "dev",
        hash: "h",
        last4: "abcd",
      })
      expect(workspaceKey.scopes).toEqual([])
      expect(workspaceKey.packageNames).toEqual([])
      for (const field of [
        "createdByMembershipId",
        "createdByMentraUserId",
        "createdByEmail",
        "issuedByService",
        "expiresAt",
        "lastUsedAt",
        "revokedAt",
      ] as const) {
        expect(workspaceKey[field]).toBeNull()
      }
      const operatorKey = await AccessCredentialModel.create({
        credentialId: "01HZ0000000000000000000002",
        prefix: "mak",
        credentialKind: "organization",
        name: "ops",
        env: "dev",
        hash: "h2",
        last4: "wxyz",
      })
      expect(operatorKey.workspaceId).toBeNull()
    })

    test("enforces a unique credentialId and the prefix and kind enums", async () => {
      const base = {prefix: "msk", credentialKind: "workspace", name: "n", env: "dev", hash: "h", last4: "1234"}
      await AccessCredentialModel.create({...base, credentialId: "cred_1"})
      expect((await thrown(() => AccessCredentialModel.create({...base, credentialId: "cred_1"}))).code).toBe(11000)
      const badPrefix = await thrown(() =>
        AccessCredentialModel.create({...base, credentialId: "cred_2", prefix: "xyz"}),
      )
      expect(badPrefix.name).toBe("ValidationError")
      const badKind = await thrown(() =>
        AccessCredentialModel.create({...base, credentialId: "cred_3", credentialKind: "user"}),
      )
      expect(badKind.name).toBe("ValidationError")
    })
  })

  describe("workspace audit events", () => {
    test("stores the actor, mixed payloads, and a unique event id", async () => {
      const row = await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000010",
        workspaceId: "ws_1",
        action: "membership.role_changed",
        actor: {kind: "user", mentraUserId: "mu_1", email: "owner@example.com"},
        target: {membershipId: "wm_a"},
        before: {role: "member"},
        after: {role: "admin"},
        occurredAt: new Date(),
      })
      expect(row.actor?.kind).toBe("user")
      expect(row.requestId).toBeNull()
      const stored = await WorkspaceAuditEventModel.findOne({eventId: "01HZ0000000000000000000010"}).lean()
      expect(stored?.before).toEqual({role: "member"})
      expect(stored?.after).toEqual({role: "admin"})
      expect(stored?.target).toEqual({membershipId: "wm_a"})
      expect(
        (
          await thrown(() =>
            WorkspaceAuditEventModel.create({
              eventId: "01HZ0000000000000000000010",
              action: "workspace.created",
              actor: {kind: "system"},
              occurredAt: new Date(),
            }),
          )
        ).code,
      ).toBe(11000)
    })

    test("requires an action, an actor and a time, and indexes the workspace audit page newest first", async () => {
      const event = {
        eventId: "01HZ0000000000000000000020",
        action: "workspace.created",
        actor: {kind: "system"},
        occurredAt: new Date(),
      }
      for (const field of ["eventId", "action", "actor", "occurredAt"] as const) {
        const {[field]: _omitted, ...rest} = event
        expect((await thrown(() => WorkspaceAuditEventModel.create(rest))).name).toBe("ValidationError")
      }
      await WorkspaceAuditEventModel.create(event)
      const indexes = await WorkspaceAuditEventModel.collection.indexes()
      const byKey = (key: Record<string, number>) =>
        indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key))
      expect(byKey({eventId: 1})?.unique).toBe(true)
      expect(byKey({workspaceId: 1, eventId: -1})).toBeDefined()
    })

    test("indexes the change feed by seq, and the index is not unique", async () => {
      // `workspace_audit_events` is populated in every deployment, and Azure Cosmos DB cannot add a unique
      // index to a populated collection: a unique seq index would stop an upgrade. Sequence order comes from
      // the counter's transaction, not from the index.
      const index = (await WorkspaceAuditEventModel.collection.indexes()).find(
        candidate => JSON.stringify(candidate.key) === JSON.stringify({seq: 1}),
      )
      expect(index).toBeDefined()
      expect(index!.unique).not.toBe(true)
      const [fields, options] = WorkspaceAuditEventModel.schema.indexes().find(([f]) => "seq" in f)!
      expect(fields).toEqual({seq: 1})
      expect(options.unique).not.toBe(true)
    })

    test("takes a seq only from events recorded for the feed: older events and organization events have none", async () => {
      const row = await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000030",
        action: "credential.created",
        actor: {kind: "system"},
        occurredAt: new Date(),
      })
      expect(row.seq).toBeUndefined()
      const stored = await WorkspaceAuditEventModel.collection.findOne({eventId: "01HZ0000000000000000000030"})
      expect(stored).not.toHaveProperty("seq")
      await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000031",
        seq: 5,
        action: "workspace.created",
        actor: {kind: "system"},
        occurredAt: new Date(),
      })
      expect((await WorkspaceAuditEventModel.findOne({eventId: "01HZ0000000000000000000031"}).lean())?.seq).toBe(5)
    })

    test("allows organization-level events without a workspace and validates the actor kind", async () => {
      const row = await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000011",
        action: "credential.revoked",
        actor: {kind: "service", service: "store"},
        occurredAt: new Date(),
      })
      expect(row.workspaceId).toBeNull()
      for (const kind of ["user", "credential", "service", "system"]) {
        await WorkspaceAuditEventModel.create({
          eventId: `01HZ00000000000000000000${kind.slice(0, 2).toUpperCase()}`,
          action: "x",
          actor: {kind},
          occurredAt: new Date(),
        })
      }
      expect(
        (
          await thrown(() =>
            WorkspaceAuditEventModel.create({
              eventId: "01HZ0000000000000000000012",
              action: "x",
              actor: {kind: "robot"},
              occurredAt: new Date(),
            }),
          )
        ).name,
      ).toBe("ValidationError")
    })
  })

  describe("workspace audit counter", () => {
    test("is one document under a fixed id that starts at 0 and cannot be created twice", async () => {
      const row = await WorkspaceAuditCounterModel.create({_id: WORKSPACE_AUDIT_COUNTER_ID})
      expect(row.seq).toBe(0)
      expect(
        (await thrown(() => WorkspaceAuditCounterModel.create({_id: WORKSPACE_AUDIT_COUNTER_ID}))).code,
      ).toBe(11000)
      expect(WorkspaceAuditCounterModel.collection.collectionName).toBe("workspace_audit_counters")
    })
  })

  describe("withTransaction", () => {
    test("commits every write and returns the callback result", async () => {
      const result = await withTransaction(async session => {
        await WorkspaceModel.create([{workspaceId: "ws_tx1", name: "One"}], {session})
        await WorkspaceModel.create([{workspaceId: "ws_tx2", name: "Two"}], {session})
        return "done"
      })
      expect(result).toBe("done")
      expect(await WorkspaceModel.countDocuments({workspaceId: {$in: ["ws_tx1", "ws_tx2"]}})).toBe(2)
    })

    test("rolls back both writes when the callback throws, and rethrows the original error", async () => {
      const boom = new Error("rollback please")
      const err = await thrown(() =>
        withTransaction(async session => {
          await WorkspaceModel.create([{workspaceId: "ws_tx1", name: "One"}], {session})
          await WorkspaceMembershipModel.create([membership({membershipId: "wm_tx1", workspaceId: "ws_tx1"})], {
            session,
          })
          throw boom
        }),
      )
      expect(err).toBe(boom)
      expect(await WorkspaceModel.countDocuments({workspaceId: "ws_tx1"})).toBe(0)
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: "ws_tx1"})).toBe(0)
    })

    test("rolls back earlier writes when a later write violates a unique index", async () => {
      await WorkspaceModel.create({workspaceId: "ws_dup", name: "Existing"})
      const err = await thrown(() =>
        withTransaction(async session => {
          await WorkspaceModel.create([{workspaceId: "ws_new", name: "New"}], {session})
          await WorkspaceModel.create([{workspaceId: "ws_dup", name: "Dup"}], {session})
        }),
      )
      expect(err.code).toBe(11000)
      expect(await WorkspaceModel.countDocuments({workspaceId: "ws_new"})).toBe(0)
    })

    test("rolls back a membership insert that collides with the active-membership index", async () => {
      await WorkspaceMembershipModel.create(membership({membershipId: "wm_existing"}))
      const err = await thrown(() =>
        withTransaction(async session => {
          await WorkspaceModel.create([{workspaceId: "ws_side", name: "Side"}], {session})
          await WorkspaceMembershipModel.create([membership({membershipId: "wm_dup"})], {session})
        }),
      )
      expect(err.code).toBe(11000)
      expect(await WorkspaceModel.countDocuments({workspaceId: "ws_side"})).toBe(0)
      expect(await WorkspaceMembershipModel.countDocuments({membershipId: "wm_dup"})).toBe(0)
    })
  })

  describe("legacy browser identities", () => {
    test("one row per WorkOS user, its email lowercased, unclaimed until claimed", async () => {
      const row = await LegacyBrowserIdentityModel.create({workosUserId: "user_01A", email: " Dev@Studio.Example "})
      expect(row).toMatchObject({workosUserId: "user_01A", email: "dev@studio.example", claimedAt: null, claimedBy: null})
      const duplicate = await thrown(() => LegacyBrowserIdentityModel.create({workosUserId: "user_01A", email: "x@studio.example"}))
      expect(duplicate.code).toBe(11000)
      // Two WorkOS users may share an address: the claim takes both for the person who verified it.
      await LegacyBrowserIdentityModel.create({workosUserId: "user_01B", email: "dev@studio.example"})
      expect(await LegacyBrowserIdentityModel.countDocuments({email: "dev@studio.example"})).toBe(2)
      const indexes = await LegacyBrowserIdentityModel.collection.indexes()
      expect(indexes.find(index => JSON.stringify(index.key) === JSON.stringify({workosUserId: 1}))?.unique).toBe(true)
      expect(indexes.find(index => JSON.stringify(index.key) === JSON.stringify({email: 1}))).toBeDefined()
      expect(indexes.find(index => JSON.stringify(index.key) === JSON.stringify({claimedBy: 1}))).toBeDefined()
    })
  })

  describe("startup migrations", () => {
    test("build every workspace index before Core serves, not in the background", async () => {
      // Drop the collections, and with them the indexes built in beforeAll.
      assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
      for (const model of MODELS) await model.collection.drop().catch(() => undefined)

      await runStartupMigrations()

      for (const model of MODELS) {
        const built = await model.collection.indexes()
        const keys = built.map(index => JSON.stringify(index.key))
        for (const [fields, options] of model.schema.indexes()) {
          expect({model: model.modelName, fields, has: keys.includes(JSON.stringify(fields))}).toEqual({
            model: model.modelName,
            fields,
            has: true,
          })
          // A partial unique index is built with its filter, not as a plain unique index.
          if (options.partialFilterExpression) {
            const index = built.find(candidate => JSON.stringify(candidate.key) === JSON.stringify(fields))
            expect(index?.partialFilterExpression).toEqual(options.partialFilterExpression)
          }
        }
      }
    })
  })
})
