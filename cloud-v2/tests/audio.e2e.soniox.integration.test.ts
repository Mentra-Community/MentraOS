/**
 * @fileoverview Full-wire real-Soniox e2e: client → UDP → cloud → Soniox → WS.
 *
 * This is the end-to-end counterpart to `soniox.integration.test.ts` (which
 * exercises the provider in isolation). Here a real TestClient runs the whole
 * v2 path: it authenticates, opens the WS, sends `connection.init` with a
 * transcription/translation subscription, streams REAL speech audio over UDP
 * as raw PCM (codec "pcm", so no LC3 encoder is needed on the sending side),
 * and asserts a real `stream.transcript` / `stream.translation` comes back.
 *
 * Gated on `SONIOX_API_KEY` + macOS `say`/`afconvert`, exactly like the
 * provider test. Run it with:
 *   doppler run -- bun test tests/audio.e2e.soniox.integration.test.ts
 * Offline (no key) the whole suite skips so the default `bun test` stays green.
 */

import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13010;
const AUDIO_HTTP_PORT = 13011;
const AUDIO_UDP_PORT = 18010;
const TEST_OEM_PORT = 13110;

const HAS_KEY = !!process.env.SONIOX_API_KEY;
const HAS_SAY = existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert");
const RUN = HAS_KEY && HAS_SAY;

if (!RUN) {
  console.log(
    `[audio.e2e.soniox] skipped (SONIOX_API_KEY=${HAS_KEY ? "set" : "missing"}, say/afconvert=${HAS_SAY ? "present" : "missing"}). Run with: doppler run -- bun test tests/audio.e2e.soniox.integration.test.ts`,
  );
}

// === Env setup BEFORE any package imports ===
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPemWrap(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPemWrap(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
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
  process.env.MONGO_URL ??=
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-audio-e2e-soniox-test";
  // Own Redis DB so this suite doesn't stomp the other audio suites.
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/3";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  // The whole point: use the real Soniox provider in the workers.
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
import { TestClient, type AudioSubscription } from "../test/test-client/src/client";

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
  for (const pattern of ["audio:*", "sessionTag:*", "{user:*}:owner"]) {
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

describe.skipIf(!RUN)("audio e2e (real Soniox over the wire)", () => {
  test("captions: PCM speech over UDP yields a real stream.transcript", async () => {
    const best = await runAudio("alice-e2e-caps", pcmEn, {
      kind: "transcription",
      language: { mode: "specific", code: "en" },
    });
    console.log(`[audio.e2e.soniox] caption: "${best}"`);
    const low = best.toLowerCase();
    expect(best.length).toBeGreaterThan(0);
    expect(low).toContain("quick");
    expect(low).toContain("fox");
  }, 45_000);

  test("translation: PCM speech over UDP yields a real stream.translation", async () => {
    const best = await runAudio("alice-e2e-xlate", pcmEn, {
      kind: "translation",
      source: { mode: "specific", code: "en" },
      target: "es",
    });
    console.log(`[audio.e2e.soniox] translation: "${best}"`);
    expect(best.length).toBeGreaterThan(0);
    const low = best.toLowerCase();
    expect(low).toMatch(/zorro|perro|r[áa]pido|salta|perezoso/);
  }, 45_000);
});

/**
 * Connect a client (codec pcm), subscribe, stream the PCM over UDP at ~2x
 * realtime, and return the longest transcript/translation text seen.
 */
async function runAudio(
  tenantUserId: string,
  pcm: Int16Array,
  sub: AudioSubscription,
): Promise<string> {
  const wantType =
    sub.kind === "translation" ? "stream.translation" : "stream.transcript";
  const client = new TestClient({
    testOemUrl: testOemHandle.url,
    coreUrl: coreHandle.url,
    audioWsUrl: audioHandle.wsUrl,
    tenantUserId,
    codec: "pcm",
  });
  // Seed the subscription into connection.init (applied before audio flows).
  client.subscribe([sub]);
  await client.connect();
  // Give the worker a beat to open the Soniox session before audio starts.
  await sleep(300);

  // Stream as 100ms PCM frames (1600 samples) at ~2x realtime, then append
  // ~1.5s of silence. Real speech ends in silence; that trailing gap is what
  // makes Soniox emit an endpoint and flush the final transcript AND the
  // translation (translation lags the source text and only settles at the
  // utterance boundary).
  const FRAME_SAMPLES = 1600;
  const speechFrames: Int16Array[] = [];
  for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
    speechFrames.push(pcm.subarray(i, i + FRAME_SAMPLES));
  }
  const silence = new Int16Array(FRAME_SAMPLES); // zeros
  const silenceFrames = Array.from({ length: 15 }, () => silence);

  for (const frame of [...speechFrames, ...silenceFrames]) {
    client.sendAudio(
      new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    );
    await sleep(50);
  }
  // Let trailing/final results land.
  await sleep(3000);

  const best = client.messages
    .filter((m) => m.type === wantType)
    .map((m) => (m as { payload: { text: string } }).payload.text)
    .reduce((a, t) => (t.length > a.length ? t : a), "");

  await client.close();
  return best;
}

/** macOS `say` -> 16 kHz mono signed-16 PCM, returned as an Int16Array. */
function generateSpeechPcm(phrase: string): Int16Array {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 12)}`;
  const aiff = join(tmpdir(), `mentra-e2e-say-${stamp}.aiff`);
  const wav = join(tmpdir(), `mentra-e2e-say-${stamp}.wav`);

  const say = Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase]);
  if (say.exitCode !== 0) throw new Error(`say failed: ${say.stderr}`);
  const conv = Bun.spawnSync([
    "/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE",
  ]);
  if (conv.exitCode !== 0) throw new Error(`afconvert failed: ${conv.stderr}`);

  const buf = readFileSync(wav);
  const dataIdx = buf.indexOf("data");
  if (dataIdx < 0) throw new Error("no data chunk in WAV");
  const pcmStart = dataIdx + 8;
  const pcmBytes = buf.subarray(pcmStart);
  const usable = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  return new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, usable / 2);
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
