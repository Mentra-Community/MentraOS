/**
 * @fileoverview Real managed-photo e2e against the runtime camera service.
 *
 * No mocks: the test plays the device. It opens a real WS (for the push), asks
 * the runtime for a managed photo over REST, uploads REAL image bytes to the
 * presigned upload URL, and asserts the real completion path fires: a
 * `photo.ready` push arrives over the WS and the read URL serves back the exact
 * bytes that were uploaded.
 *
 * Runs on the local storage provider (real temp-fs storage that the runtime
 * serves itself) so it needs no third-party credentials. The same flow runs
 * against Cloudflare R2 when STORAGE_S3_* creds are present, where completion
 * instead arrives via the storage-events webhook (exercised below too).
 */

import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13030;
const AUDIO_HTTP_PORT = 13031;
const AUDIO_UDP_PORT = 18030;
const TEST_OEM_PORT = 13130;

// === Env setup BEFORE any package imports ===
{
  const access = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    access.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    access.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  // Runtime verifies cloud-runtime tokens against these issuers; trust the
  // cloud-core issuer Core brokers its runtime tokens from (see issueRuntimeToken).
  process.env.CLOUD_RUNTIME_AUTH_ISSUERS ??= JSON.stringify([
    {
      issuer: "cloud-core",
      publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY",
      userIdClaim: "sub",
      oemIdClaim: "oem_id",
    },
  ]);
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-camera-test";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/5";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  // Real local-fs storage provider (runtime serves its own blobs).
  process.env.STORAGE_PROVIDER ??= "local";
  process.env.LOG_LEVEL ??= "warn";
}

import { startCore, type CoreHandle } from "../packages/core/src/index";
import { startAudio, type AudioHandle } from "../packages/runtime/src/index";
import { startTestOem, type TestOemHandle } from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import { getRedis } from "../packages/runtime/src/clients/redis.client";
import { TestClient } from "../test/test-client/src/client";

let coreHandle: CoreHandle;
let audioHandle: AudioHandle;
let testOemHandle: TestOemHandle;

const BASE = () => `http://localhost:${AUDIO_HTTP_PORT}`;

beforeAll(async () => {
  const { resetMentraKeyCache } = await import("../packages/shared/src/auth");
  const { resetSigningKeyCache } = await import(
    "../packages/core/src/services/session.service"
  );
  resetMentraKeyCache();
  resetSigningKeyCache();

  testOemHandle = await startTestOem({ port: TEST_OEM_PORT, tenantId: TEST_OEM_ID });
  coreHandle = await startCore({ port: CORE_PORT });
  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);
  audioHandle = await startAudio({
    httpPort: AUDIO_HTTP_PORT,
    udpPort: AUDIO_UDP_PORT,
    udpAdvertisedHost: "127.0.0.1",
    udpAdvertisedPort: AUDIO_UDP_PORT,
  });
});

afterAll(async () => {
  await audioHandle?.stop();
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
  const redis = getRedis();
  for (const pattern of ["sessionTag:*", "{user:*}:owner", "photo-request:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  await OemModel.create({
    tenantId: TEST_OEM_ID,
    displayName: "Test OEM",
    publicKeyMode: "static",
    publicKey: `-----BEGIN PUBLIC KEY-----\n${testOemHandle.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
  });
});

describe("managed photo (real device upload)", () => {
  test("request -> device uploads real bytes -> photo.ready -> readUrl serves them", async () => {
    const client = await connectDevice("alice-cam-photo");

    // 1. Ask the runtime for a managed photo.
    const { requestId, uploadUrl, readUrl } = await requestPhoto(client.token);
    expect(requestId).toMatch(/^photo_/);

    // 2. The device uploads the captured image to the presigned URL. Real bytes
    //    (a minimal JPEG: SOI + EOI markers plus a payload), not a placeholder.
    const image = makeImageBytes();
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: image,
    });
    expect(put.ok).toBe(true);

    // 3. The completion path fires a photo.ready push to the WS.
    const ready = (await client.waitFor("photo.ready", 5000)) as {
      payload: { requestId: string; readUrl: string };
    };
    expect(ready.payload.requestId).toBe(requestId);

    // 4. The read URL serves back the EXACT bytes the device uploaded.
    const got = await fetch(readUrl);
    expect(got.ok).toBe(true);
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(bytes).toEqual(image);

    await client.close();
  }, 20_000);

  test("storage-events webhook completes the photo (r2/s3 path)", async () => {
    const client = await connectDevice("alice-cam-webhook");
    const { requestId } = await requestPhoto(client.token);

    // The object-created event the storage provider would fire reaches the
    // webhook (this is what the R2 -> Queue -> Worker wiring posts).
    const event = await fetch(`${BASE()}/api/camera/storage-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: `photos/${requestId}` }),
    });
    expect(event.status).toBe(204);

    const ready = (await client.waitFor("photo.ready", 5000)) as {
      payload: { requestId: string };
    };
    expect(ready.payload.requestId).toBe(requestId);

    await client.close();
  }, 20_000);

  test.each(["low", "high", "max"] as const)(
    "accepts canonical size %s on POST /api/camera/photo",
    async (size) => {
      const client = await connectDevice(`alice-cam-${size}`);
      const { requestId, uploadUrl } = await requestPhoto(client.token, size);
      expect(requestId).toMatch(/^photo_/);

      const image = makeImageBytes();
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: image,
      });
      expect(put.ok).toBe(true);

      const ready = (await client.waitFor("photo.ready", 5000)) as {
        payload: { requestId: string };
      };
      expect(ready.payload.requestId).toBe(requestId);
      await client.close();
    },
    20_000,
  );

  test("rejects invalid photo size with HTTP 400", async () => {
    const client = await connectDevice("alice-cam-bad-size");
    const res = await fetch(`${BASE()}/api/camera/photo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.token}`,
      },
      body: JSON.stringify({ size: "gigantic" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid photo options");
    await client.close();
  }, 20_000);
});

// === Helpers ===

async function connectDevice(tenantUserId: string): Promise<TestClient> {
  const client = new TestClient({
    testOemUrl: testOemHandle.url,
    coreUrl: coreHandle.url,
    audioWsUrl: audioHandle.wsUrl,
    tenantUserId,
  });
  await client.connect();
  return client;
}

async function requestPhoto(
  token: string,
  size: string = "medium",
): Promise<{ requestId: string; uploadUrl: string; readUrl: string }> {
  const res = await fetch(`${BASE()}/api/camera/photo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ size }),
  });
  if (!res.ok) throw new Error(`photo request failed: ${res.status}`);
  return (await res.json()) as { requestId: string; uploadUrl: string; readUrl: string };
}

/** A small but real JPEG byte sequence (SOI ... EOI). */
function makeImageBytes(): Uint8Array {
  const body = new Uint8Array(64);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
  return new Uint8Array([0xff, 0xd8, 0xff, ...body, 0xff, 0xd9]);
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
