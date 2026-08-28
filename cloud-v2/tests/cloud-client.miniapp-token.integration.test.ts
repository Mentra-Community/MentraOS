/**
 * @fileoverview getMiniappToken e2e through @mentra/cloud-client (node).
 *
 * Boots real core + test-oem against the local Mongo + Redis (no audio server,
 * no Soniox: minting a miniapp token is a pure auth-plane flow). Exchanges an
 * OEM JWT for a Mentra access token, then calls cloud.auth.getMiniappToken and
 * asserts the returned token is audience-pinned to the requested miniapp and
 * subject-pinned to the signed-in user. Also asserts the per-packageName cache:
 * a second call returns the same token until it nears expiry.
 *
 * Run with: bun test tests/cloud-client.miniapp-token.integration.test.ts
 * (needs Mongo at 127.0.0.1:27017 and Redis at 127.0.0.1:6379).
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13030;
const STORE_PORT = 13033;
const TEST_OEM_PORT = 13130;
const TEST_PACKAGE = "com.test.app";

// === Env setup BEFORE any package imports ===
{
  const access = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    access.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    access.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  // The miniapp-token signing key MUST be distinct from the access-token key
  // (the blast-radius guarantee): generate a separate ed25519 keypair for it.
  const miniapp = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = stripPemWrap(
    miniapp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = stripPemWrap(
    miniapp.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??=
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-cloudclient-miniapp-test";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/5";
  process.env.LOG_LEVEL ??= "warn";
}

import { startCore, type CoreHandle } from "../packages/core/src/index";
import { startStore, type StoreHandle } from "../packages/store/src/index";
import { startTestOem, type TestOemHandle } from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { CloudClient } from "../packages/cloud-client/node";

let coreHandle: CoreHandle;
let storeHandle: StoreHandle;
let testOemHandle: TestOemHandle;

beforeAll(async () => {
  const { resetMentraKeyCache } = await import("../packages/shared/src/auth");
  const { resetSigningKeyCache } = await import(
    "../packages/core/src/services/session.service"
  );
  resetMentraKeyCache();
  resetSigningKeyCache();

  testOemHandle = await startTestOem({ port: TEST_OEM_PORT, tenantId: TEST_OEM_ID });
  coreHandle = await startCore({ port: CORE_PORT });
  process.env.MENTRA_STORE_CORE_JWKS_URL = `${coreHandle.url}/.well-known/jwks.json`;
  storeHandle = await startStore({ port: STORE_PORT });
  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);
}, 30_000);

afterAll(async () => {
  await storeHandle?.stop();
  await coreHandle?.stop();
  await testOemHandle?.stop();
});

beforeEach(async () => {
  await Promise.all([
    OemModel.deleteMany({}),
    UserModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    SeenJtiModel.deleteMany({}),
    RevokedJtiModel.deleteMany({}),
  ]);
  await OemModel.create({
    tenantId: TEST_OEM_ID,
    displayName: "Test OEM",
    publicKeyMode: "static",
    publicKey: `-----BEGIN PUBLIC KEY-----\n${testOemHandle.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
  });
});

describe("cloud.auth.getMiniappToken (real core)", () => {
  test("mints a token pinned to the miniapp (aud) and the user (sub)", async () => {
    const cloud = await newCloud("bob-miniapp");

    // The access token must exist first so identity is readable. getMiniappToken
    // exchanges on demand, but we read identity to compare against the claims.
    await cloud.auth.getCoreToken();
    const { mentraUserId } = cloud.auth.identity;

    const { token, expiresAt } = await cloud.auth.getMiniappToken(TEST_PACKAGE);
    expect(token.length).toBeGreaterThan(0);
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const claims = decodeJwtClaims(token);
    expect(claims.aud).toBe(TEST_PACKAGE);
    expect(claims.sub).toBe(mentraUserId);
    expect(claims.tenantId).toBe(TEST_OEM_ID);
  });

  test("caches per packageName: a second call returns the same token", async () => {
    const cloud = await newCloud("carol-miniapp");

    const first = await cloud.auth.getMiniappToken(TEST_PACKAGE);
    const second = await cloud.auth.getMiniappToken(TEST_PACKAGE);

    // Cached until near expiry, so the same token string comes back without a
    // fresh mint.
    expect(second.token).toBe(first.token);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  test("Store endpoints accept only the configured Store miniapp audience", async () => {
    const cloud = await newCloud("store-user");
    const storeToken = await cloud.auth.getMiniappToken("com.mentra.store");
    const storeResponse = await fetch(`${storeHandle.url}/api/store/apps`, {
      headers: { authorization: `Bearer ${storeToken.token}` },
    });
    expect(storeResponse.status).toBe(200);

    const unrelatedToken = await cloud.auth.getMiniappToken(TEST_PACKAGE);
    const unrelatedResponse = await fetch(`${storeHandle.url}/api/store/apps`, {
      headers: { authorization: `Bearer ${unrelatedToken.token}` },
    });
    expect(unrelatedResponse.status).toBe(401);
  });

});

// === Helpers ===

async function newCloud(tenantUserId: string): Promise<CloudClient> {
  const mintRes = await fetch(`${testOemHandle.url}/test-oem/mint-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantUserId }),
  });
  if (!mintRes.ok) throw new Error(`mint-jwt failed: ${mintRes.status}`);
  const { jwt } = (await mintRes.json()) as { jwt: string };

  return new CloudClient({
    endpoints: { core: coreHandle.url, store: storeHandle.url, runtime: `http://localhost:${CORE_PORT}` },
    auth: {
      core: { subjectToken: jwt, subjectTokenType: "oem-jwt" },
      runtime: { source: "core" },
    },
  });
}

/** Decode a JWT's claims (no signature check; the cloud already signed it). */
function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("malformed JWT: no payload segment");
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
