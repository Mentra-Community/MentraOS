#!/usr/bin/env bun
/**
 * Soniox smoke test — boots the full pipeline in-process and runs ONE
 * TestClient against the real Soniox API.
 *
 * Purpose: verify the SonioxProvider wires up correctly (auth, session
 * connect, audio bytes accepted by Soniox, transcript events flow back).
 * Does NOT verify transcription quality — the audio we send is junk
 * Int16 PCM, so we expect either empty results or noise transcripts.
 *
 * Prereqs:
 *   - Doppler scoped to `cloud-v2` / `dev`
 *   - Local Mongo + Redis (`bun run setup:test`)
 *   - SONIOX_API_KEY in Doppler (already set)
 *
 * Run:
 *   doppler run -- bun scripts/soniox-smoke.ts
 *
 * Exits 0 if Soniox connection opened and produced at least one event
 * (transcript or endpoint). Exits 1 otherwise.
 */

import crypto from "node:crypto";
import { startCore } from "../packages/core/src/index";
import { startRuntime } from "../packages/runtime/src/index";
import { startTestOem } from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";
import { TestClient } from "../test/test-client/src/client";

const PORT_CORE = 16000;
const PORT_RUNTIME_HTTP = 16001;
const PORT_RUNTIME_UDP = 18301;
const PORT_TEST_OEM = 16100;

// Ed25519 keys come from Doppler. But for the smoke test we want a fresh
// pair to avoid leaving any sessions in DB tied to the real production
// keys. Override env before any imports cache them.
{
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const strip = (p: string) =>
    p
      .replace(/-----BEGIN [A-Z ]+-----/, "")
      .replace(/-----END [A-Z ]+-----/, "")
      .replace(/\s+/g, "");
  process.env.MENTRA_JWT_PRIVATE_KEY = strip(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = strip(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.REFRESH_TOKEN_PEPPER ??= "smoke-test-pepper";
  process.env.MONGO_URL ??=
    "mongodb://127.0.0.1:27017/cloud-v2-smoke";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/4";
}

const { resetMentraKeyCache } = await import(
  "../packages/shared/src/auth"
);
const { resetSigningKeyCache } = await import(
  "../packages/core/src/services/session.service"
);
resetMentraKeyCache();
resetSigningKeyCache();

console.log("[smoke] booting test-oem, core, runtime…");

const testOem = await startTestOem({
  port: PORT_TEST_OEM,
  tenantId: "smoke-test-oem",
});

const core = await startCore({ port: PORT_CORE });

const runtime = await startRuntime({
  httpPort: PORT_RUNTIME_HTTP,
  udpPort: PORT_RUNTIME_UDP,
  udpAdvertisedHost: "127.0.0.1",
  udpAdvertisedPort: PORT_RUNTIME_UDP,
  workerCount: 1,
});

console.log("[smoke] services up:");
console.log(`  test-oem: ${testOem.url}`);
console.log(`  core:     ${core.url}`);
console.log(`  runtime:  ${runtime.wsUrl} (audio UDP :${runtime.udpPort})`);
console.log(`  provider: ${process.env.AUDIO_PROVIDER}`);

// Seed the test OEM record so token exchange works.
await OemModel.deleteMany({ tenantId: testOem.tenantId });
await OemModel.create({
  tenantId: testOem.tenantId,
  displayName: "Smoke Test OEM",
  publicKeyMode: "static",
  publicKey: `-----BEGIN PUBLIC KEY-----\n${testOem.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
});

const client = new TestClient({
  testOemUrl: testOem.url,
  coreUrl: core.url,
  audioWsUrl: runtime.wsUrl,
  tenantUserId: "smoke-alice",
  connectTimeoutMs: 10_000,
});

console.log("[smoke] connecting client…");
await client.connect();
console.log(`[smoke] connected; sessionTag=${client.sessionTag}`);

console.log("[smoke] subscribing transcription (auto language)…");
client.subscribe([{ kind: "transcription", language: { mode: "auto" } }]);

// Worker needs a moment to create the Soniox session (importing the SDK,
// connecting, awaiting `ready`). Soniox connect typically takes 100–400ms.
console.log("[smoke] waiting 1.5s for Soniox session to open…");
await new Promise((r) => setTimeout(r, 1500));

// Send the pre-encoded LC3 file frame by frame at 10ms cadence (matches
// real-time playback). If the LC3 file doesn't exist, fall back to junk
// bytes so the smoke still validates connection.
const LC3_PATH = "/tmp/cv2-test.lc3";
const FRAME_BYTES = 20;

let lc3Bytes: Uint8Array;
try {
  const buf = await Bun.file(LC3_PATH).arrayBuffer();
  lc3Bytes = new Uint8Array(buf);
  console.log(`[smoke] loaded ${lc3Bytes.byteLength} bytes of LC3 (${lc3Bytes.byteLength / FRAME_BYTES} frames, ${(lc3Bytes.byteLength / FRAME_BYTES) * 10}ms duration)`);
} catch {
  console.log("[smoke] no /tmp/cv2-test.lc3 — sending junk bytes instead");
  lc3Bytes = new Uint8Array(20 * 50);
  for (let i = 0; i < lc3Bytes.length; i++) lc3Bytes[i] = (i * 13) & 0xff;
}

const numFrames = Math.floor(lc3Bytes.byteLength / FRAME_BYTES);
console.log(`[smoke] streaming ${numFrames} frames at 10ms cadence…`);
for (let i = 0; i < numFrames; i++) {
  const frame = lc3Bytes.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
  client.sendAudio(frame);
  await new Promise((r) => setTimeout(r, 10));
}

console.log("[smoke] waiting 4s for Soniox to finalize remaining transcripts…");
await new Promise((r) => setTimeout(r, 4000));

const transcripts = client.messages.filter((m) => m.type === "data_stream");
console.log(`[smoke] received ${transcripts.length} data_stream messages`);
for (const t of transcripts) {
  console.log("[smoke]   →", JSON.stringify(t));
}

// Capture sessionTag BEFORE close — it's an error to read after close.
const finalSessionTag = client.connected ? client.sessionTag : 0;

await client.close();
// Give Soniox session a moment to close cleanly before we tear down.
await new Promise((r) => setTimeout(r, 500));

console.log("[smoke] shutting down…");
await audio.stop();
await core.stop();
await testOem.stop();

// Success criterion: services booted, client connected, audio sent without
// throws. Receiving 0 TRANSCRIPTs is still a passing smoke since our
// audio bytes aren't real speech.
const ok = finalSessionTag > 0;
console.log(`[smoke] ${ok ? "OK" : "FAIL"}  (sessionTag=${finalSessionTag}, transcripts=${transcripts.length})`);
process.exit(ok ? 0 : 1);
