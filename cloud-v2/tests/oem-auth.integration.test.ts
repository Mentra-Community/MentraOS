/**
 * @fileoverview End-to-end integration tests for the OEM auth flow.
 *
 * Wires:
 *   TEST OEM (in-process)
 *     ↓ signs JWT with its private key
 *   core's POST /api/client/auth/exchange (in-process via app.fetch)
 *     ↓ verifies, mints Mentra access + refresh
 *   assertions on response shape + downstream rejection paths
 *
 * Prereq: a running Mongo. Defaults to `mongodb://127.0.0.1:27017/mentra-cloud-v2-test`;
 * override via `MONGO_URL`. The test wipes its own collections between cases —
 * do NOT point this at a real database.
 *
 * Run: `bun test tests/oem-auth.integration.test.ts`
 */

import crypto from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

// Set crypto material env vars BEFORE importing core so the lazy key loader
// finds them on its first call. REFRESH_TOKEN_PEPPER is read inline on every
// hash, so order doesn't strictly matter for it, but setting all three here
// keeps the test prelude in one place.
{
  const { privateKey: nodePriv, publicKey: nodePub } =
    crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    nodePriv.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    nodePub.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??=
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-test";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
  mongoReadinessCheck,
} from "../packages/core/src/connections/mongo.connection";
import { createApp } from "../packages/core/src/api/app";
import { OemModel } from "../packages/core/src/models/oem.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { loadKeypair, type TestOemKeypair } from "../test/test-oem/src/keypair";
import { mintJwt } from "../test/test-oem/src/app";

const TEST_OEM_ID = "test-oem";

let coreApp: ReturnType<typeof createApp>;
let oemKeypair: TestOemKeypair;

// === Test lifecycle ===

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);

  // Build indexes before any test depends on them (the seen-jti replay test
  // relies on the unique index firing).
  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);

  coreApp = createApp({ readinessChecks: [mongoReadinessCheck] });
  oemKeypair = await loadKeypair({ kid: `${TEST_OEM_ID}-key-1` });
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    OemModel.deleteMany({}),
    UserModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    SeenJtiModel.deleteMany({}),
    RevokedJtiModel.deleteMany({}),
  ]);

  // Seed the test OEM with its public key. Real flow uses POST /api/oem/jwks,
  // which is portal-auth-gated and not implemented yet; for tests we
  // shortcut by inserting the record directly.
  await OemModel.create({
    tenantId: TEST_OEM_ID,
    displayName: "Test OEM",
    publicKeyMode: "static",
    publicKey: toPemWrap(oemKeypair.publicKeyBody, "PUBLIC KEY"),
  });
});

// === Tests ===

describe("OEM auth — token exchange", () => {
  test("happy path: mint → exchange → tokens", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-1" },
    });

    const res = await exchange(jwt);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT shape
    expect(body.refresh_token.length).toBeGreaterThan(20);

    // User row was created on first sight.
    const user = await UserModel.findOne({
      tenantId: TEST_OEM_ID,
      tenantUserId: "alice-1",
    }).lean();
    expect(user).not.toBeNull();
    expect(user?.mentraUserId).toMatch(/^mu_/);
  });

  test("replay: same JWT exchanged twice → second rejected", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-2" },
    });
    const first = await exchange(jwt);
    expect(first.status).toBe(200);

    const second = await exchange(jwt);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("wrong audience → invalid_grant", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-3", audience: "not-mentra" },
    });
    const res = await exchange(jwt);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("expired JWT → invalid_grant", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      // Negative ttlSec mints an exp in the past. Bigger negative than the
      // 5-min clock skew tolerance so the rejection is unambiguous.
      options: { tenantUserId: "alice-4", ttlSec: -60 * 10 },
    });
    const res = await exchange(jwt);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("unknown OEM → unauthorized_client", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: "not-registered-with-mentra",
      options: { tenantUserId: "alice-5" },
    });
    const res = await exchange(jwt);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unauthorized_client",
    );
  });

  test("disabled OEM → unauthorized_client", async () => {
    await OemModel.updateOne(
      { tenantId: TEST_OEM_ID },
      { $set: { disabled: true } },
    );
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-6" },
    });
    const res = await exchange(jwt);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unauthorized_client",
    );
  });

  test("malformed JWT → invalid_request", async () => {
    const res = await exchange("not-a-jwt-at-all");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });
});

describe("OEM auth — refresh", () => {
  test("happy path: exchange → refresh → new tokens, rotated", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-7" },
    });
    const exchangeRes = await exchange(jwt);
    const { refresh_token: rt1, access_token: at1 } =
      (await exchangeRes.json()) as {
        refresh_token: string;
        access_token: string;
      };

    const refreshRes = await refresh(rt1);
    expect(refreshRes.status).toBe(200);
    const body = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(body.access_token).not.toBe(at1);
    expect(body.refresh_token).not.toBe(rt1);
  });

  test("reuse: predecessor dies only after its successor is first used", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-8" },
    });
    const { refresh_token: rt1 } = (await (await exchange(jwt)).json()) as {
      refresh_token: string;
    };

    const first = await refresh(rt1);
    expect(first.status).toBe(200);
    const { refresh_token: rt2 } = (await first.json()) as {
      refresh_token: string;
    };

    // One-step recovery window: until rt2 is used, presenting rt1 again is
    // treated as "the rt2 response never reached the client" and succeeds
    // (see session.service.ts rotation + refresh-rotation.integration.test.ts).
    const recovery = await refresh(rt1);
    expect(recovery.status).toBe(200);
    const { refresh_token: rt3 } = (await recovery.json()) as {
      refresh_token: string;
    };

    // First use of the live successor retires the predecessor for good.
    const successorUse = await refresh(rt3);
    expect(successorUse.status).toBe(200);

    const afterRetirement = await refresh(rt1);
    expect(afterRetirement.status).toBe(400);
    expect(((await afterRetirement.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("refresh after OEM disabled → unauthorized_client", async () => {
    const { jwt } = await mintJwt({
      keypair: oemKeypair,
      tenantId: TEST_OEM_ID,
      options: { tenantUserId: "alice-9" },
    });
    const { refresh_token: rt } = (await (await exchange(jwt)).json()) as {
      refresh_token: string;
    };

    await OemModel.updateOne(
      { tenantId: TEST_OEM_ID },
      { $set: { disabled: true } },
    );

    const res = await refresh(rt);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unauthorized_client",
    );
  });
});

// === Helpers ===

async function exchange(jwt: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: jwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });
  return coreApp.fetch(
    new Request("http://localhost/api/client/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

async function refresh(refreshToken: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return coreApp.fetch(
    new Request("http://localhost/api/client/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

function toPemWrap(body: string, label: "PUBLIC KEY" | "PRIVATE KEY"): string {
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
