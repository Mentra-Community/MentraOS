/**
 * @fileoverview Startup migration integration tests.
 *
 * Covers the legacy oemId -> tenantId backfills that keep pre-rename rows usable
 * with the current schema. Prereq: a running Mongo (override via MONGO_URL).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  connectMongo,
  disconnectMongo,
} from "../packages/core/src/connections/mongo.connection";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { runStartupMigrations } from "../packages/core/src/migrations/startup.migrations";

beforeAll(async () => {
  await connectMongo(
    process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2-test",
  );
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await RefreshTokenModel.collection.deleteMany({ sessionId: /^sess_mig_/ });
});

describe("startup migrations", () => {
  test("backfills tenantId from oemId on legacy refresh tokens", async () => {
    const col = RefreshTokenModel.collection;
    // Legacy row minted before the rename: has oemId, no tenantId.
    await col.insertOne({
      sessionId: "sess_mig_legacy",
      mentraUserId: "mu_mig_1",
      refreshTokenHash: "hash_mig_legacy",
      oemId: "acme",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // Current row: already has tenantId and must be left untouched.
    await col.insertOne({
      sessionId: "sess_mig_current",
      mentraUserId: "mu_mig_2",
      refreshTokenHash: "hash_mig_current",
      tenantId: "globex",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await runStartupMigrations();

    const legacy = await col.findOne({ sessionId: "sess_mig_legacy" });
    expect(legacy?.tenantId).toBe("acme");
    const current = await col.findOne({ sessionId: "sess_mig_current" });
    expect(current?.tenantId).toBe("globex");
  });
});
