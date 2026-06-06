/**
 * @fileoverview End-to-end test driven by the real @mentra/cloud-client (node).
 *
 * This is the integration-test harness the rollout calls for: the SAME client
 * the phone runs, on a server, exercising the whole v2 path against the runtime:
 *   - cloud.auth exchanges the OEM JWT at /api/client/auth/exchange
 *   - cloud.runtime opens the WS, does the connection.init/ack handshake
 *   - cloud.runtime.setSubscriptions PUTs the guarded subscription write
 *   - cloud.runtime.sendAudioFrame encrypts frames and sends them over UDP
 *   - transcripts come back as typed onTranscript / onTranslation events
 *
 * It runs against the MOCK provider (the default), so it is offline and
 * deterministic: the mock emits a transcript per audio frame, which proves the
 * full wire without a real ASR. The real-Soniox proof lives in
 * audio.e2e.soniox.integration.test.ts.
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

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13020;
const AUDIO_HTTP_PORT = 13021;
const AUDIO_UDP_PORT = 18020;
const TEST_OEM_PORT = 13120;

// === Env setup BEFORE any package imports ===
{
  const access = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    access.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    access.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  // Second keypair for miniapp-scoped tokens (separate from the access key).
  const miniapp = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY ??= stripPemWrap(
    miniapp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY ??= stripPemWrap(
    miniapp.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "test-pepper-not-for-production";
  process.env.MONGO_URL ??=
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-cloudclient-test";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/4";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  // Local storage provider (default) + dev auto-capture, so the managed-photo
  // flow completes without real glasses: the runtime stores a placeholder and
  // serves it back at the readUrl.
  process.env.STORAGE_PROVIDER ??= "local";
  process.env.CAMERA_AUTOCAPTURE ??= "true";
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
import { CloudClient } from "../packages/cloud-client/node";
import { TestClient } from "../test/test-client/src/client";
import type {
  TranscriptionData,
  TranslationData,
} from "../packages/runtime/src/protocol";

let coreHandle: CoreHandle;
let audioHandle: AudioHandle;
let testOemHandle: TestOemHandle;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const { resetMentraKeyCache } = await import("../packages/shared/src/auth");
  const { resetSigningKeyCache } = await import(
    "../packages/core/src/services/session.service"
  );
  resetMentraKeyCache();
  resetSigningKeyCache();

  testOemHandle = await startTestOem({ port: TEST_OEM_PORT, oemId: TEST_OEM_ID });
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
  for (const pattern of [
    "audio:*",
    "sessionTag:*",
    "{user:*}:owner",
    "{user:*}:subscriptions",
    "{user:*}:control",
    "photo-request:*",
  ]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  await OemModel.create({
    oemId: TEST_OEM_ID,
    displayName: "Test OEM",
    publicKeyMode: "static",
    publicKey: `-----BEGIN PUBLIC KEY-----\n${testOemHandle.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
  });
});

describe("cloud-client e2e (the real client as harness)", () => {
  test("auth exchange + handshake + subscribe + encrypted audio -> transcript", async () => {
    const cloud = await newCloud("alice-cc-caps");

    const transcripts: TranscriptionData[] = [];
    cloud.runtime.onTranscript((d) => transcripts.push(d));

    await cloud.runtime.connect();
    // identity is read off the exchanged access token's claims.
    expect(cloud.auth.identity.mentraUserId).toMatch(/^[a-f0-9]{24}$|^mu_/);

    await cloud.runtime.setSubscriptions([
      { kind: "transcription", language: { mode: "auto" } },
    ]);

    const ok = await pumpAudioUntil(
      () => transcripts.length > 0,
      () => cloud.runtime.sendAudioFrame(new Uint8Array(40).fill(0x42)),
    );
    expect(ok).toBe(true);

    const t = transcripts[0]!;
    expect(t.provider).toBe("mock");
    expect(t.subscription.kind).toBe("transcription");
    // MockProvider text format: `mock <scope> <n>`.
    expect(t.text).toMatch(/^mock /);

    cloud.runtime.close();
    await sleep(100);
  }, 20_000);

  test("translation subscription -> onTranslation", async () => {
    const cloud = await newCloud("alice-cc-xlate");

    const translations: TranslationData[] = [];
    cloud.runtime.onTranslation((d) => translations.push(d));

    await cloud.runtime.connect();
    await cloud.runtime.setSubscriptions([
      { kind: "translation", source: { mode: "auto" }, target: "es" },
    ]);

    const ok = await pumpAudioUntil(
      () => translations.length > 0,
      () => cloud.runtime.sendAudioFrame(new Uint8Array(40).fill(0x77)),
    );
    expect(ok).toBe(true);

    const t = translations[0]!;
    expect(t.subscription.kind).toBe("translation");
    expect(t.target.language).toBe("es");

    cloud.runtime.close();
    await sleep(100);
  }, 20_000);

  test("managed photo: request -> photo.ready push -> resolves with readUrl", async () => {
    const cloud = await newCloud("alice-cc-photo");
    await cloud.runtime.connect();

    // requestPhoto resolves only when the cloud pushes photo.ready over the WS
    // (the mock provider simulates the capture). No fixed wait: the await is the
    // event.
    const photo = await cloud.runtime.requestManagedPhoto({ size: "medium" });
    expect(photo.requestId).toMatch(/^photo_/);
    expect(photo.readUrl).toContain("/api/camera/blob/photos/");
    expect(photo.readUrl).toContain(photo.requestId);

    // The readUrl serves REAL bytes from the local storage provider (proving the
    // storage round-trip, not a mock URL pointing nowhere).
    const res = await fetch(photo.readUrl);
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body).toContain("mentra-local-placeholder-photo");

    cloud.runtime.close();
    await sleep(100);
  }, 20_000);

  test("managed stream: provision over REST + stop", async () => {
    const cloud = await newCloud("alice-cc-stream");
    await cloud.runtime.connect();

    const stream = await cloud.runtime.startManagedStream({});
    expect(stream.streamId).toMatch(/^stream_/);
    expect(typeof (stream.ingest as { url?: string }).url).toBe("string");
    expect(typeof (stream.playback as { url?: string }).url).toBe("string");

    // Stop returns 204; should resolve without throwing.
    await cloud.runtime.stopManagedStream(stream.streamId);

    cloud.runtime.close();
    await sleep(100);
  }, 20_000);

  test("storage webhook completes a photo (r2-style completion path)", async () => {
    // Exercise the OTHER completion trigger: the storage object-created event
    // reaching the webhook (what R2 wiring posts), instead of the local upload.
    // Turn auto-capture off for this one so the webhook is the only completion.
    const prev = process.env.CAMERA_AUTOCAPTURE;
    process.env.CAMERA_AUTOCAPTURE = "false";
    const base = `http://localhost:${AUDIO_HTTP_PORT}`;
    try {
      // A raw WS to receive the push (test-client is the low-level harness).
      const client = new TestClient({
        testOemUrl: testOemHandle.url,
        coreUrl: coreHandle.url,
        audioWsUrl: audioHandle.wsUrl,
        oemUserId: "alice-cc-webhook",
      });
      await client.connect();

      // Request a photo over REST (no auto-capture now, so it stays pending).
      const photoRes = await fetch(`${base}/api/camera/photo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${client.token}`,
        },
        body: "{}",
      });
      expect(photoRes.ok).toBe(true);
      const { requestId } = (await photoRes.json()) as { requestId: string };

      // Simulate the provider's object-created event hitting the webhook.
      const eventRes = await fetch(`${base}/api/camera/storage-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: `photos/${requestId}` }),
      });
      expect(eventRes.status).toBe(204);

      // The push should land on the WS.
      const ready = (await client.waitFor("photo.ready", 5000)) as {
        payload: { requestId: string; readUrl: string };
      };
      expect(ready.payload.requestId).toBe(requestId);

      await client.close();
    } finally {
      process.env.CAMERA_AUTOCAPTURE = prev;
    }
  }, 20_000);
});

// === Helpers ===

async function newCloud(oemUserId: string): Promise<CloudClient> {
  const mintRes = await fetch(`${testOemHandle.url}/test-oem/mint-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oemUserId }),
  });
  if (!mintRes.ok) throw new Error(`mint-jwt failed: ${mintRes.status}`);
  const { jwt } = (await mintRes.json()) as { jwt: string };

  return new CloudClient({
    endpoints: {
      core: coreHandle.url,
      runtime: `http://localhost:${AUDIO_HTTP_PORT}`,
    },
    auth: { subjectToken: jwt, subjectTokenType: "oem-jwt" },
  });
}

/**
 * Pump audio frames until a result lands (or a deadline passes). This is the
 * realistic streaming shape: keep feeding frames and stop the instant the event
 * fires, rather than waiting a fixed interval and hoping the provider is ready.
 */
async function pumpAudioUntil(
  done: () => boolean,
  sendFrame: () => void,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    sendFrame();
    await sleep(50);
  }
  return done();
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
