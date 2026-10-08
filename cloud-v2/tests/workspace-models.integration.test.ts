/**
 * @fileoverview Workspace models, local-only test Mongo guard, and `withTransaction`.
 *
 * The `localTestMongoUrl` guard tests run without Mongo. The model and
 * transaction tests need a local replica set (transactions require one). They
 * connect through `localTestMongoUrl`, which ignores `MONGO_URL`, picks a
 * random database name, and refuses anything that is not loopback, so this
 * file can never touch a shared or live database. Each run drops its database.
 *
 * Prereq: a local replica set at `CLOUD_V2_TEST_MONGO_URL`
 * (default `mongodb://127.0.0.1:27017`, i.e. `docker-compose.test.yml`).
 *
 * Run: `bun test tests/workspace-models.integration.test.ts`
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  connectMongo,
  disconnectMongo,
  withTransaction,
} from "../packages/core/src/connections/mongo.connection";
import { AccessCredentialModel } from "../packages/core/src/models/access-credential.model";
import { IdentityLinkModel } from "../packages/core/src/models/identity-link.model";
import { WORKSPACE_AUDIT_COUNTER_ID, WorkspaceAuditCounterModel } from "../packages/core/src/models/workspace-audit-counter.model";
import { WorkspaceAuditEventModel } from "../packages/core/src/models/workspace-audit-event.model";
import { WorkspaceInvitationModel } from "../packages/core/src/models/workspace-invitation.model";
import { WorkspaceMembershipModel } from "../packages/core/src/models/workspace-membership.model";
import { WorkspaceModel } from "../packages/core/src/models/workspace.model";
import { runStartupMigrations } from "../packages/core/src/migrations/startup.migrations";
import { assertConnectedTo, localTestMongoUrl } from "./support/local-mongo";
import { membershipRow } from "./support/membership-row";

const MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
  IdentityLinkModel,
];

/** Run `fn` and return whatever it throws (fails the test if it does not throw). */
async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("localTestMongoUrl guard", () => {
  const saved = {
    base: process.env.CLOUD_V2_TEST_MONGO_URL,
    legacy: process.env.MONGO_URL,
  };

  afterEach(() => {
    if (saved.base === undefined) delete process.env.CLOUD_V2_TEST_MONGO_URL;
    else process.env.CLOUD_V2_TEST_MONGO_URL = saved.base;
    if (saved.legacy === undefined) delete process.env.MONGO_URL;
    else process.env.MONGO_URL = saved.legacy;
  });

  function withBase(url: string): string {
    process.env.CLOUD_V2_TEST_MONGO_URL = url;
    return localTestMongoUrl("guard");
  }

  test("rejects SRV (Atlas) URLs", () => {
    expect(() => withBase("mongodb+srv://x.mongodb.net")).toThrow();
  });

  test("rejects URLs that carry credentials", () => {
    expect(() => withBase("mongodb://user:pw@127.0.0.1")).toThrow();
    expect(() => withBase("mongodb://user@127.0.0.1:27017")).toThrow();
  });

  test("rejects non-loopback hosts", () => {
    expect(() => withBase("mongodb://10.0.0.5:27017")).toThrow();
    expect(() => withBase("mongodb://db.example.com:27017")).toThrow();
    expect(() => withBase("mongodb://0.0.0.0:27017")).toThrow();
    expect(() => withBase("mongodb://127.0.0.1.evil.test:27017")).toThrow();
    expect(() => withBase("mongodb://localhost.evil.test:27017")).toThrow();
  });

  test("rejects multi-host seed lists, unparseable URLs, and other schemes", () => {
    expect(() => withBase("mongodb://127.0.0.1:27017,10.0.0.5:27017")).toThrow();
    expect(() => withBase("mongodb://127.0.0.1:notaport")).toThrow();
    expect(() => withBase("not a url")).toThrow();
    expect(() => withBase("http://127.0.0.1:27017")).toThrow();
  });

  test("rejects a base URL that already names a database or options", () => {
    expect(() => withBase("mongodb://127.0.0.1:27017/mentra-prod")).toThrow();
    expect(() => withBase("mongodb://127.0.0.1:27017/?authSource=admin")).toThrow();
  });

  test("rejects unsafe or empty database prefixes", () => {
    process.env.CLOUD_V2_TEST_MONGO_URL = "mongodb://127.0.0.1:27017";
    expect(() => localTestMongoUrl("")).toThrow();
    expect(() => localTestMongoUrl("a/b")).toThrow();
    expect(() => localTestMongoUrl("a.b")).toThrow();
    expect(() => localTestMongoUrl("a".repeat(41))).toThrow();
  });

  test("accepts loopback hosts and returns a random database with directConnection", () => {
    const first = withBase("mongodb://127.0.0.1:27031");
    expect(first).toMatch(/^mongodb:\/\/127\.0\.0\.1:27031\/guard-[0-9a-f]{12}\?directConnection=true$/);
    expect(withBase("mongodb://localhost:27031/")).toMatch(
      /^mongodb:\/\/localhost:27031\/guard-[0-9a-f]{12}\?directConnection=true$/,
    );
    expect(withBase("mongodb://127.0.0.1:27031")).not.toBe(first);
  });

  test("defaults to the local compose Mongo when unset", () => {
    delete process.env.CLOUD_V2_TEST_MONGO_URL;
    expect(localTestMongoUrl("guard")).toMatch(
      /^mongodb:\/\/127\.0\.0\.1:27017\/guard-[0-9a-f]{12}\?directConnection=true$/,
    );
  });

  test("ignores MONGO_URL entirely", () => {
    process.env.MONGO_URL = "mongodb://10.0.0.5:27017/prod";
    process.env.CLOUD_V2_TEST_MONGO_URL = "mongodb://127.0.0.1:27031";
    expect(localTestMongoUrl("guard")).toStartWith("mongodb://127.0.0.1:27031/guard-");
    delete process.env.CLOUD_V2_TEST_MONGO_URL;
    expect(localTestMongoUrl("guard")).toStartWith("mongodb://127.0.0.1:27017/guard-");
  });
});

describe("assertConnectedTo guard", () => {
  const url = "mongodb://127.0.0.1:27031/workspace-models-0123456789ab?directConnection=true";

  test("passes only for the database named in the URL", () => {
    expect(() => assertConnectedTo(url, "workspace-models-0123456789ab")).not.toThrow();
    expect(() => assertConnectedTo(url, "mentra-cloud-v2-test")).toThrow(/refusing destructive test calls/);
    expect(() => assertConnectedTo(url, "")).toThrow();
    expect(() => assertConnectedTo(url, "workspace-models-0123456789ac")).toThrow();
  });

  test("refuses a URL that names no database", () => {
    expect(() => assertConnectedTo("mongodb://127.0.0.1:27031/", "")).toThrow();
    expect(() => assertConnectedTo("mongodb://127.0.0.1:27031", "test")).toThrow();
  });
});

describe("withTransaction (error mapping, no Mongo)", () => {
  test("maps a server without transaction support to an error naming the replica-set requirement", async () => {
    let ended = false;
    const serverError = Object.assign(
      new Error("Transaction numbers are only allowed on a replica set member or mongos"),
      { code: 20, codeName: "IllegalOperation" },
    );
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw serverError;
      },
      endSession: async () => {
        ended = true;
      },
    } as any);
    try {
      const err = await thrown(() => withTransaction(async () => "unreachable"));
      expect(err.message).toMatch(/replica set/i);
      expect(err.cause).toBe(serverError);
      expect(ended).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("maps the driver's topology-compatibility error", async () => {
    const compat = Object.assign(new Error("Current topology does not support sessions"), {
      name: "MongoCompatibilityError",
    });
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw compat;
      },
      endSession: async () => {},
    } as any);
    try {
      const err = await thrown(() => withTransaction(async () => 1));
      expect(err.message).toMatch(/replica set/i);
      expect(err.cause).toBe(compat);
    } finally {
      spy.mockRestore();
    }
  });

  test("does not reclassify errors that only resemble the unsupported-transactions failure", async () => {
    const lookalikes = [
      new Error("this feature does not support transactions"),
      Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), { code: 11000 }),
      Object.assign(new Error("some other illegal operation"), { code: 20 }),
      Object.assign(new Error("Current topology does not support sessions"), { name: "SomeOtherError" }),
    ];
    for (const lookalike of lookalikes) {
      const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
        withTransaction: async () => {
          throw lookalike;
        },
        endSession: async () => {},
      } as any);
      try {
        expect(await thrown(() => withTransaction(async () => 1))).toBe(lookalike);
      } finally {
        spy.mockRestore();
      }
    }
  });

  test("rethrows unrelated errors unchanged and still ends the session", async () => {
    let ended = false;
    const boom = new Error("boom");
    const spy = spyOn(WorkspaceModel.db, "startSession").mockResolvedValue({
      withTransaction: async () => {
        throw boom;
      },
      endSession: async () => {
        ended = true;
      },
    } as any);
    try {
      expect(await thrown(() => withTransaction(async () => 1))).toBe(boom);
      expect(ended).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("workspace models (local replica set)", () => {
  let databaseUrl: string;
  // Set only once the live connection is confirmed to be on our random database;
  // every destructive call below is gated on it.
  let verified = false;

  beforeAll(async () => {
    databaseUrl = localTestMongoUrl("workspace-models");
    await connectMongo(databaseUrl);
    // `connectMongo` ignores a second connect, so a connection leaked by another
    // test file would silently win. Fail before touching any data in that case.
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name);
    verified = true;
    await Promise.all(MODELS.map(model => model.init()));
  });

  afterAll(async () => {
    if (verified && WorkspaceModel.db.readyState === 1) {
      assertConnectedTo(databaseUrl, WorkspaceModel.db.name);
      await WorkspaceModel.db.dropDatabase();
    }
    await disconnectMongo();
  });

  beforeEach(async () => {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name);
    await Promise.all(MODELS.map(model => model.deleteMany({})));
  });

  const membership = (overrides: Record<string, unknown> = {}) =>
    membershipRow({
      membershipId: `wm_${Math.random().toString(36).slice(2)}`,
      workspaceId: "ws_1",
      mentraUserId: "mu_1",
      role: "member",
      startedAt: new Date(),
      ...overrides,
    } as { role: string; startedAt: Date });

  describe("workspaces", () => {
    test("applies defaults and timestamps", async () => {
      const row = await WorkspaceModel.create({ workspaceId: "ws_1", name: "Acme" });
      expect(row.status).toBe("active");
      expect(row.authorizationRevision).toBe(0);
      expect(row.createdByMentraUserId).toBeNull();
      expect(row.deletedAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    });

    test("enforces a unique workspaceId and the status enum", async () => {
      await WorkspaceModel.create({ workspaceId: "ws_1", name: "A" });
      expect((await thrown(() => WorkspaceModel.create({ workspaceId: "ws_1", name: "B" }))).code).toBe(11000);
      const invalid = await thrown(() =>
        WorkspaceModel.create({ workspaceId: "ws_2", name: "C", status: "archived" }),
      );
      expect(invalid.name).toBe("ValidationError");
    });
  });

  describe("workspace memberships", () => {
    test("rejects a second active membership for the same workspace and user (E11000)", async () => {
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_a" }));
      const err = await thrown(() => WorkspaceMembershipModel.create(membership({ membershipId: "wm_b" })));
      expect(err.code).toBe(11000);
    });

    test("allows a new generation once the previous membership has ended", async () => {
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_a" }));
      await WorkspaceMembershipModel.updateOne(
        { membershipId: "wm_a" },
        { $set: { status: "ended", endedAt: new Date(), endedReason: "removed" } },
      );
      const next = await WorkspaceMembershipModel.create(membership({ membershipId: "wm_b" }));
      expect(next.status).toBe("active");
      expect(await WorkspaceMembershipModel.countDocuments({ workspaceId: "ws_1", mentraUserId: "mu_1" })).toBe(2);
    });

    test("scopes uniqueness to the workspace", async () => {
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_a" }));
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_b", workspaceId: "ws_2" }));
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_c", mentraUserId: "mu_2" }));
    });

    test("keeps pending (migrated) memberships unique per workspace and WorkOS user", async () => {
      const pending = (id: string, overrides: Record<string, unknown> = {}) =>
        membership({ membershipId: id, mentraUserId: null, pendingWorkosUserId: "user_01", ...overrides });
      await WorkspaceMembershipModel.create(pending("wm_a"));
      expect((await thrown(() => WorkspaceMembershipModel.create(pending("wm_b")))).code).toBe(11000);
      await WorkspaceMembershipModel.create(pending("wm_c", { pendingWorkosUserId: "user_02" }));
      await WorkspaceMembershipModel.create(pending("wm_d", { workspaceId: "ws_2" }));
    });

    test("frees the pending slot once the pending membership has ended", async () => {
      const pending = (id: string) =>
        membership({ membershipId: id, mentraUserId: null, pendingWorkosUserId: "user_01" });
      await WorkspaceMembershipModel.create(pending("wm_a"));
      expect((await thrown(() => WorkspaceMembershipModel.create(pending("wm_b")))).code).toBe(11000);
      await WorkspaceMembershipModel.updateOne(
        { membershipId: "wm_a" },
        { $set: { status: "ended", endedAt: new Date(), endedReason: "removed" } },
      );
      const next = await WorkspaceMembershipModel.create(pending("wm_b"));
      expect(next.status).toBe("active");
      expect(await WorkspaceMembershipModel.countDocuments({ workspaceId: "ws_1", pendingWorkosUserId: "user_01" })).toBe(2);
    });

    test("does not collide rows that have no mentraUserId or no pendingWorkosUserId", async () => {
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_a", mentraUserId: null, pendingWorkosUserId: "user_01" }));
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_b", mentraUserId: null, pendingWorkosUserId: "user_02" }));
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_c", mentraUserId: "mu_1" }));
      await WorkspaceMembershipModel.create(membership({ membershipId: "wm_d", mentraUserId: "mu_2" }));
    });

    test("applies defaults and validates role and endedReason", async () => {
      const row = await WorkspaceMembershipModel.create(membership({ membershipId: "wm_a", role: "owner" }));
      expect(row.status).toBe("active");
      expect(row.endedAt).toBeNull();
      expect(row.endedReason).toBeNull();
      expect(row.pendingWorkosUserId).toBeNull();
      expect(row.email).toBeNull();
      expect(row.name).toBeNull();
      expect((await thrown(() => WorkspaceMembershipModel.create(membership({ membershipId: "wm_b", mentraUserId: "mu_9", role: "superuser" })))).name).toBe("ValidationError");
      expect((await thrown(() => WorkspaceMembershipModel.create(membership({ membershipId: "wm_c", mentraUserId: "mu_8", status: "ended", endedReason: "bogus" })))).name).toBe("ValidationError");
      for (const role of ["owner", "admin", "developer", "member"]) {
        await WorkspaceMembershipModel.create(membership({ membershipId: `wm_${role}`, mentraUserId: `mu_${role}`, role }));
      }
    });

    test("requires a role history of valid entries, and keeps it in order", async () => {
      const missing = await thrown(() =>
        WorkspaceMembershipModel.create(membership({ membershipId: "wm_none", mentraUserId: "mu_none", roleHistory: [] })),
      );
      expect(missing.name).toBe("ValidationError");
      const badRole = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({
            membershipId: "wm_bad",
            mentraUserId: "mu_bad",
            roleHistory: [{ role: "superuser", from: new Date(), authorizationRevision: 0 }],
          }),
        ),
      );
      expect(badRole.name).toBe("ValidationError");
      const noRevision = await thrown(() =>
        WorkspaceMembershipModel.create(
          membership({ membershipId: "wm_norev", mentraUserId: "mu_norev", roleHistory: [{ role: "member", from: new Date() }] }),
        ),
      );
      expect(noRevision.name).toBe("ValidationError");

      const first = new Date("2026-01-01T00:00:00.000Z");
      const second = new Date("2026-02-01T00:00:00.000Z");
      await WorkspaceMembershipModel.create(
        membership({
          membershipId: "wm_ok",
          role: "admin",
          startedAt: first,
          roleHistory: [
            { role: "member", from: first, authorizationRevision: 1 },
            { role: "admin", from: second, authorizationRevision: 4 },
          ],
        }),
      );
      const row = await WorkspaceMembershipModel.findOne({ membershipId: "wm_ok" }).lean();
      expect(row!.roleHistory as unknown).toEqual([
        { role: "member", from: first, authorizationRevision: 1 },
        { role: "admin", from: second, authorizationRevision: 4 },
      ]);
    });
  });

  describe("workspace invitations", () => {
    const invitation = (overrides: Record<string, unknown> = {}) => ({
      invitationId: `winv_${Math.random().toString(36).slice(2)}`,
      workspaceId: "ws_1",
      email: "Dev@Example.com",
      role: "developer",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    test("lowercases email, defaults to pending, and validates role", async () => {
      const row = await WorkspaceInvitationModel.create(invitation());
      expect(row.email).toBe("dev@example.com");
      expect(row.status).toBe("pending");
      expect(row.invitedByMembershipId).toBeNull();
      expect(row.acceptedMembershipId).toBeNull();
      expect((await thrown(() => WorkspaceInvitationModel.create(invitation({ email: "x@example.com", role: "root" })))).name).toBe("ValidationError");
    });

    test("allows one pending invitation per workspace and email", async () => {
      await WorkspaceInvitationModel.create(invitation({ invitationId: "winv_a" }));
      expect((await thrown(() => WorkspaceInvitationModel.create(invitation({ invitationId: "winv_b", email: "dev@example.com" })))).code).toBe(11000);
      await WorkspaceInvitationModel.create(invitation({ invitationId: "winv_c", workspaceId: "ws_2" }));
      await WorkspaceInvitationModel.updateOne({ invitationId: "winv_a" }, { $set: { status: "revoked" } });
      await WorkspaceInvitationModel.create(invitation({ invitationId: "winv_d" }));
      await WorkspaceInvitationModel.updateOne({ invitationId: "winv_d" }, { $set: { status: "accepted" } });
      await WorkspaceInvitationModel.create(invitation({ invitationId: "winv_e" }));
    });
  });

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
      });
      expect(workspaceKey.scopes).toEqual([]);
      expect(workspaceKey.packageNames).toEqual([]);
      for (const field of ["createdByMembershipId", "createdByMentraUserId", "createdByEmail", "issuedByService", "expiresAt", "lastUsedAt", "revokedAt"] as const) {
        expect(workspaceKey[field]).toBeNull();
      }
      const operatorKey = await AccessCredentialModel.create({
        credentialId: "01HZ0000000000000000000002",
        prefix: "mak",
        credentialKind: "organization",
        name: "ops",
        env: "dev",
        hash: "h2",
        last4: "wxyz",
      });
      expect(operatorKey.workspaceId).toBeNull();
    });

    test("enforces a unique credentialId and the prefix and kind enums", async () => {
      const base = { prefix: "msk", credentialKind: "workspace", name: "n", env: "dev", hash: "h", last4: "1234" };
      await AccessCredentialModel.create({ ...base, credentialId: "cred_1" });
      expect((await thrown(() => AccessCredentialModel.create({ ...base, credentialId: "cred_1" }))).code).toBe(11000);
      expect((await thrown(() => AccessCredentialModel.create({ ...base, credentialId: "cred_2", prefix: "xyz" }))).name).toBe("ValidationError");
      expect((await thrown(() => AccessCredentialModel.create({ ...base, credentialId: "cred_3", credentialKind: "user" }))).name).toBe("ValidationError");
    });
  });

  describe("workspace audit events", () => {
    test("stores the actor, mixed payloads, and a unique event id", async () => {
      const row = await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000010",
        seq: 1,
        workspaceId: "ws_1",
        action: "membership.role_changed",
        actor: { kind: "user", mentraUserId: "mu_1", email: "owner@example.com" },
        target: { membershipId: "wm_a" },
        before: { role: "member" },
        after: { role: "admin" },
        occurredAt: new Date(),
      });
      expect(row.actor?.kind).toBe("user");
      expect(row.requestId).toBeNull();
      const stored = await WorkspaceAuditEventModel.findOne({ eventId: "01HZ0000000000000000000010" }).lean();
      expect(stored?.before).toEqual({ role: "member" });
      expect(stored?.after).toEqual({ role: "admin" });
      expect(stored?.target).toEqual({ membershipId: "wm_a" });
      expect((await thrown(() => WorkspaceAuditEventModel.create({ eventId: "01HZ0000000000000000000010", seq: 99, action: "workspace.created", actor: { kind: "system" }, occurredAt: new Date() }))).code).toBe(11000);
    });

    test("enforces a unique seq across the feed, requires it, and indexes the workspace audit page", async () => {
      const event = { action: "workspace.created", actor: { kind: "system" }, occurredAt: new Date() };
      await WorkspaceAuditEventModel.create({ ...event, eventId: "01HZ0000000000000000000020", seq: 1 });
      // The same position is refused, whatever the event id.
      expect((await thrown(() => WorkspaceAuditEventModel.create({ ...event, eventId: "01HZ0000000000000000000021", seq: 1 }))).code).toBe(11000);
      expect((await thrown(() => WorkspaceAuditEventModel.create({ ...event, eventId: "01HZ0000000000000000000023" }))).name).toBe("ValidationError");
      const indexes = await WorkspaceAuditEventModel.collection.indexes();
      expect(indexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ seq: 1 }))?.unique).toBe(true);
      expect(indexes.some((index) => JSON.stringify(index.key) === JSON.stringify({ workspaceId: 1, eventId: -1 }))).toBe(true);
    });

    test("keeps a single change-feed counter under its fixed id", async () => {
      await WorkspaceAuditCounterModel.create({ _id: WORKSPACE_AUDIT_COUNTER_ID });
      expect((await WorkspaceAuditCounterModel.findById(WORKSPACE_AUDIT_COUNTER_ID).lean())?.seq).toBe(0);
      expect((await thrown(() => WorkspaceAuditCounterModel.create({ _id: WORKSPACE_AUDIT_COUNTER_ID }))).code).toBe(11000);
    });

    test("allows organization-level events without a workspace and validates the actor kind", async () => {
      const row = await WorkspaceAuditEventModel.create({
        eventId: "01HZ0000000000000000000011",
        seq: 2,
        action: "credential.revoked",
        actor: { kind: "service", service: "store" },
        occurredAt: new Date(),
      });
      expect(row.workspaceId).toBeNull();
      expect((await thrown(() => WorkspaceAuditEventModel.create({ eventId: "01HZ0000000000000000000012", seq: 3, action: "x", actor: { kind: "robot" }, occurredAt: new Date() }))).name).toBe("ValidationError");
    });
  });

  describe("identity links", () => {
    test("is unique per provider and subject and validates enums", async () => {
      const link = { provider: "workos", subject: "user_01", mentraUserId: "mu_1", linkedVia: "verified_email" };
      const row = await IdentityLinkModel.create(link);
      expect(row.email).toBeNull();
      expect((await thrown(() => IdentityLinkModel.create({ ...link, mentraUserId: "mu_2" }))).code).toBe(11000);
      await IdentityLinkModel.create({ ...link, subject: "user_02", linkedVia: "workos_tenant" });
      expect((await thrown(() => IdentityLinkModel.create({ ...link, subject: "user_03", provider: "okta" }))).name).toBe("ValidationError");
      expect((await thrown(() => IdentityLinkModel.create({ ...link, subject: "user_04", linkedVia: "guess" }))).name).toBe("ValidationError");
    });
  });

  describe("withTransaction", () => {
    test("commits every write and returns the callback result", async () => {
      const result = await withTransaction(async session => {
        await WorkspaceModel.create([{ workspaceId: "ws_tx1", name: "One" }], { session });
        await WorkspaceModel.create([{ workspaceId: "ws_tx2", name: "Two" }], { session });
        return "done";
      });
      expect(result).toBe("done");
      expect(await WorkspaceModel.countDocuments({ workspaceId: { $in: ["ws_tx1", "ws_tx2"] } })).toBe(2);
    });

    test("rolls back both writes when the callback throws, and rethrows the original error", async () => {
      const boom = new Error("rollback please");
      const err = await thrown(() =>
        withTransaction(async session => {
          await WorkspaceModel.create([{ workspaceId: "ws_tx1", name: "One" }], { session });
          await WorkspaceMembershipModel.create([membership({ membershipId: "wm_tx1", workspaceId: "ws_tx1" })], { session });
          throw boom;
        }),
      );
      expect(err).toBe(boom);
      expect(await WorkspaceModel.countDocuments({ workspaceId: "ws_tx1" })).toBe(0);
      expect(await WorkspaceMembershipModel.countDocuments({ workspaceId: "ws_tx1" })).toBe(0);
    });

    test("rolls back earlier writes when a later write violates a unique index", async () => {
      await WorkspaceModel.create({ workspaceId: "ws_dup", name: "Existing" });
      const err = await thrown(() =>
        withTransaction(async session => {
          await WorkspaceModel.create([{ workspaceId: "ws_new", name: "New" }], { session });
          await WorkspaceModel.create([{ workspaceId: "ws_dup", name: "Dup" }], { session });
        }),
      );
      expect(err.code).toBe(11000);
      expect(await WorkspaceModel.countDocuments({ workspaceId: "ws_new" })).toBe(0);
    });
  });

  describe("startup migrations", () => {
    test("build every workspace and identity-link index before Core serves, not in the background", async () => {
      // Drop the collections, and with them the indexes autoIndex built when the models were initialised.
      assertConnectedTo(databaseUrl, WorkspaceModel.db.name);
      for (const model of MODELS) await model.collection.drop().catch(() => undefined);

      await runStartupMigrations();

      for (const model of MODELS) {
        const built = (await model.collection.indexes()).map(index => JSON.stringify(index.key));
        for (const [fields] of model.schema.indexes()) {
          expect({ model: model.modelName, has: built.includes(JSON.stringify(fields)) }).toEqual({
            model: model.modelName,
            has: true,
          });
        }
      }
    });
  });
});
