/**
 * @fileoverview Startup migration integration tests.
 *
 * Covers the legacy oemId -> tenantId backfills that keep pre-rename rows usable
 * with the current schema.
 *
 * Safety: the migrations run against the whole connected database, so the test
 * connects through `localTestMongoUrl` (loopback only, random database name,
 * ignores `MONGO_URL`) and asserts the live connection is on that database
 * before any write. The database is dropped in `afterAll`, only if the check
 * passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/startup-migrations.integration.test.ts`
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  connectMongo,
  disconnectMongo,
} from "../packages/core/src/connections/mongo.connection";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { runStartupMigrations } from "../packages/core/src/migrations/startup.migrations";
import { assertConnectedTo, localTestMongoUrl } from "./support/local-mongo";

const databaseUrl = localTestMongoUrl("startup-migrations");
// Set only once the live connection is confirmed to be our random database;
// every write is gated on it.
let verified = false;

beforeAll(async () => {
  await connectMongo(databaseUrl);
  assertConnectedTo(databaseUrl, RefreshTokenModel.db.name);
  verified = true;
});

afterAll(async () => {
  if (verified && RefreshTokenModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, RefreshTokenModel.db.name);
    await RefreshTokenModel.db.dropDatabase();
  }
  await disconnectMongo();
});

beforeEach(async () => {
  assertConnectedTo(databaseUrl, RefreshTokenModel.db.name);
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

    assertConnectedTo(databaseUrl, RefreshTokenModel.db.name);
    await runStartupMigrations();

    const legacy = await col.findOne({ sessionId: "sess_mig_legacy" });
    expect(legacy?.tenantId).toBe("acme");
    const current = await col.findOne({ sessionId: "sess_mig_current" });
    expect(current?.tenantId).toBe("globex");
  });
});
