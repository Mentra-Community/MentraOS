/**
 * @fileoverview Real end-to-end test driven by @mentra/cloud-client (node).
 *
 * The SAME client the phone runs, on a server, exercising the whole v2 path for
 * real, no mocks: OEM-JWT exchange at /api/client/auth/exchange, the
 * connection.init/ack handshake, guarded REST subscriptions, encrypted UDP
 * audio, and REAL Soniox transcription + translation coming back as typed
 * onTranscript / onTranslation events.
 *
 * The client streams real speech (macOS `say` + `afconvert`, 16 kHz mono PCM) as
 * raw PCM frames through cloud.runtime.sendAudioFrame, so it needs no LC3
 * encoder. Gated on SONIOX_API_KEY + say/afconvert; run with:
 *   doppler run -- bun test tests/cloud-client.e2e.integration.test.ts
 * Offline (no key) the whole suite skips.
 */

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13020;
const AUDIO_HTTP_PORT = 13021;
const AUDIO_UDP_PORT = 18020;
const TEST_OEM_PORT = 13120;

const HAS_KEY = !!process.env.SONIOX_API_KEY;
const HAS_SAY = existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert");
const RUN = HAS_KEY && HAS_SAY;

if (!RUN) {
  console.log(
    `[cloud-client.e2e] skipped (SONIOX_API_KEY=${HAS_KEY ? "set" : "missing"}, say/afconvert=${HAS_SAY ? "present" : "missing"}). Run with: doppler run -- bun test tests/cloud-client.e2e.integration.test.ts`,
  );
}

// === Env setup BEFORE any package imports ===
{
  const access = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    access.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    access.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
    {
      issuer: "cloud-core",
      publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY",
      userIdClaim: "sub",
      tenantIdClaim: "tenant_id",
    },
  ]);
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
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/mentra-cloud-v2-cloudclient-test";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/4";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  // Real Soniox provider in the workers.
  process.env.AUDIO_PROVIDER = "soniox";
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
import type {
  TranscriptionData,
  TranslationData,
} from "../packages/runtime/src/protocol";

let coreHandle: CoreHandle;
let audioHandle: AudioHandle;
let testOemHandle: TestOemHandle;
let pcmEn: Int16Array;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!RUN) return;
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
  pcmEn = generateSpeechPcm("the quick brown fox jumps over the lazy dog");
}, 30_000);

afterAll(async () => {
  await audioHandle?.stop();
  await coreHandle?.stop();
  await testOemHandle?.stop();
});

beforeEach(async () => {
  if (!RUN) return;
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
  ]) {
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

describe.skipIf(!RUN)("cloud-client real e2e (the real client + real Soniox)", () => {
  test("captions: real speech over the client -> real transcript", async () => {
    const cloud = await newCloud("alice-cc-caps");
    const transcripts: TranscriptionData[] = [];
    cloud.runtime.onTranscript((d) => transcripts.push(d));

    await cloud.runtime.connect();
    await cloud.runtime.setSubscriptions([
      { kind: "transcription", language: { mode: "specific", code: "en" } },
    ]);

    const best = await streamAndCollect(cloud, transcripts);
    console.log(`[cloud-client.e2e] caption: "${best}"`);
    const low = best.toLowerCase();
    expect(best.length).toBeGreaterThan(0);
    expect(low).toContain("quick");
    expect(low).toContain("fox");

    cloud.runtime.close();
    await sleep(200);
  }, 45_000);

  test("translation: real speech over the client -> real Spanish", async () => {
    const cloud = await newCloud("alice-cc-xlate");
    const translations: TranslationData[] = [];
    cloud.runtime.onTranslation((d) => translations.push(d));

    await cloud.runtime.connect();
    await cloud.runtime.setSubscriptions([
      { kind: "translation", source: { mode: "specific", code: "en" }, target: "es" },
    ]);

    const best = await streamAndCollect(cloud, translations);
    console.log(`[cloud-client.e2e] translation: "${best}"`);
    expect(best.length).toBeGreaterThan(0);
    expect(best.toLowerCase()).toMatch(/zorro|perro|r[áa]pido|salta|perezoso/);

    cloud.runtime.close();
    await sleep(200);
  }, 45_000);
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
    endpoints: { core: coreHandle.url, runtime: `http://localhost:${AUDIO_HTTP_PORT}` },
    auth: {
      core: { subjectToken: jwt, subjectTokenType: "oem-jwt" },
      // Broker the runtime token from Core (mobile uses the same path); the
      // runtime trusts the cloud-core issuer via CLOUD_RUNTIME_AUTH_ISSUERS.
      runtime: { source: "core" },
    },
    // Feed raw PCM (the say-generated audio) rather than LC3.
    audio: { codec: "pcm", sampleRate: 16000 },
  });
}

/**
 * Give the worker a beat to open the Soniox session, stream the phrase as 100ms
 * PCM frames at ~2x realtime followed by trailing silence (so Soniox hits an
 * endpoint and flushes the final result + translation), then let results settle.
 * Returns the longest text seen.
 */
async function streamAndCollect(
  cloud: CloudClient,
  results: Array<{ text: string }>,
): Promise<string> {
  await sleep(400); // Soniox session connect latency (real, not a mock)

  const FRAME = 1600; // 100 ms at 16 kHz
  const frames: Int16Array[] = [];
  for (let i = 0; i < pcmEn.length; i += FRAME) frames.push(pcmEn.subarray(i, i + FRAME));
  const silence = new Int16Array(FRAME);
  for (let i = 0; i < 15; i++) frames.push(silence);

  for (const f of frames) {
    cloud.runtime.sendAudioFrame(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
    await sleep(50);
  }
  await sleep(3000);

  return results.reduce((a, r) => (r.text.length > a.length ? r.text : a), "");
}

/** macOS `say` -> 16 kHz mono signed-16 PCM, as an Int16Array. */
function generateSpeechPcm(phrase: string): Int16Array {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 12)}`;
  const aiff = join(tmpdir(), `mentra-cc-say-${stamp}.aiff`);
  const wav = join(tmpdir(), `mentra-cc-say-${stamp}.wav`);
  const say = Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase]);
  if (say.exitCode !== 0) throw new Error(`say failed: ${say.stderr}`);
  const conv = Bun.spawnSync([
    "/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE",
  ]);
  if (conv.exitCode !== 0) throw new Error(`afconvert failed: ${conv.stderr}`);
  const buf = readFileSync(wav);
  const dataIdx = buf.indexOf("data");
  if (dataIdx < 0) throw new Error("no data chunk in WAV");
  const pcmBytes = buf.subarray(dataIdx + 8);
  const usable = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  return new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, usable / 2);
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
