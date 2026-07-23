/**
 * @fileoverview Integration tests for refresh-token rotation recovery
 * (OS-1703). A client that sends a refresh but never receives the response
 * (killed mid-rotation, dropped connection) still holds the predecessor
 * token; before this fix, re-presenting it got `invalid_grant` and the mobile
 * client's tokenRejected path cleared the session — a permanent logout.
 *
 * Semantics under test: a rotated-away refresh token stays honored until its
 * successor is first USED. Recovery re-rotates while retaining one displaced
 * successor so duplicate responses cannot race the client into a logout;
 * anything older than the immediate predecessor still fails.
 *
 * Prereq: a running Mongo (override via MONGO_URL). Wipes its own collection.
 *
 * Run: bun test tests/refresh-rotation.integration.test.ts
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// Crypto material must be set BEFORE importing core so the lazy key loader
// picks it up (mirrors the other integration tests).
{
  const strip = (pem: string) =>
    pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = strip(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = strip(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-test";
}

// eslint-disable-next-line import/first
import {
  connectMongo,
  disconnectMongo,
} from "../packages/core/src/connections/mongo.connection";
// eslint-disable-next-line import/first
import { refreshSession } from "../packages/core/src/services/session.service";
// eslint-disable-next-line import/first
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
// eslint-disable-next-line import/first
import { OauthError } from "../packages/core/src/types/oauth.types";

/** Mirror of session.service's private hashRefreshToken. */
function hash(plaintext: string): string {
  return crypto
    .createHmac("sha256", process.env.REFRESH_TOKEN_PEPPER!)
    .update(plaintext)
    .digest("base64url");
}

/** Seed a live session whose current refresh token is `plaintext`. */
async function seedSession(plaintext: string): Promise<void> {
  await RefreshTokenModel.create({
    sessionId: `sess_test_${crypto.randomBytes(8).toString("hex")}`,
    refreshTokenHash: hash(plaintext),
    mentraUserId: "mu_test_os1703",
    tenantId: "mentra", // built-in tenant: always authorized, no OEM doc needed
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
}

async function expectInvalidGrant(refreshToken: string): Promise<void> {
  try {
    await refreshSession({ refreshToken });
    throw new Error("expected refreshSession to throw invalid_grant");
  } catch (e) {
    expect(e).toBeInstanceOf(OauthError);
    expect((e as OauthError).code).toBe("invalid_grant");
  }
}

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL!);
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await RefreshTokenModel.deleteMany({ mentraUserId: "mu_test_os1703" });
});

describe("refresh rotation recovery (OS-1703)", () => {
  test("normal rotation still works and retires the grandparent", async () => {
    const a = "token-A-" + crypto.randomBytes(16).toString("base64url");
    await seedSession(a);

    const r1 = await refreshSession({ refreshToken: a });
    expect(r1.refresh_token).toBeTruthy();

    const r2 = await refreshSession({ refreshToken: r1.refresh_token });
    expect(r2.refresh_token).toBeTruthy();

    // a is now the grandparent (its successor was used) — dead.
    await expectInvalidGrant(a);
  });

  test("lost rotation response: predecessor recovers instead of bricking the session", async () => {
    const a = "token-A-" + crypto.randomBytes(16).toString("base64url");
    await seedSession(a);

    // Client refreshes; imagine the response (carrying b) never reached it.
    const { refresh_token: b } = await refreshSession({ refreshToken: a });

    // Client re-presents a. Before the fix: invalid_grant -> clearTokens ->
    // permanent logout. After: a fresh, valid pair.
    const recovery = await refreshSession({ refreshToken: a });
    expect(recovery.refresh_token).toBeTruthy();
    expect(recovery.access_token).toBeTruthy();

    // The recovered pair is fully functional. Its confirmed use collapses
    // the original predecessor and the displaced successor branch.
    const next = await refreshSession({ refreshToken: recovery.refresh_token });
    expect(next.refresh_token).toBeTruthy();
    await expectInvalidGrant(a);
    await expectInvalidGrant(b);
  });

  test("duplicate refresh responses both remain valid until one branch is confirmed", async () => {
    const a = "token-A-" + crypto.randomBytes(16).toString("base64url");
    await seedSession(a);

    // The first response carries b. A duplicate request recovers through a
    // and carries c, displacing b. Network response ordering determines which
    // token the phone saves, so both must remain usable at this point.
    const { refresh_token: b } = await refreshSession({ refreshToken: a });
    const { refresh_token: c } = await refreshSession({ refreshToken: a });

    const viaDisplacedSibling = await refreshSession({ refreshToken: b });
    expect(viaDisplacedSibling.refresh_token).toBeTruthy();

    // Presenting b confirms that branch and retires the alternatives.
    await expectInvalidGrant(a);
    await expectInvalidGrant(c);

    const next = await refreshSession({
      refreshToken: viaDisplacedSibling.refresh_token,
    });
    expect(next.refresh_token).toBeTruthy();
  });

  test("client can recover repeatedly if it keeps losing responses", async () => {
    const a = "token-A-" + crypto.randomBytes(16).toString("base64url");
    await seedSession(a);

    await refreshSession({ refreshToken: a }); // lost
    await refreshSession({ refreshToken: a }); // lost again
    const third = await refreshSession({ refreshToken: a }); // finally lands
    expect(third.refresh_token).toBeTruthy();

    // Once the delivered successor is used, a finally dies.
    await refreshSession({ refreshToken: third.refresh_token });
    await expectInvalidGrant(a);
  });

  test("unknown and expired tokens still fail", async () => {
    await expectInvalidGrant("never-issued-token");

    const stale = "token-stale-" + crypto.randomBytes(16).toString("base64url");
    await RefreshTokenModel.create({
      sessionId: `sess_test_${crypto.randomBytes(8).toString("hex")}`,
      refreshTokenHash: hash(stale),
      mentraUserId: "mu_test_os1703",
      tenantId: "mentra",
      issuedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    await expectInvalidGrant(stale);
  });
});
