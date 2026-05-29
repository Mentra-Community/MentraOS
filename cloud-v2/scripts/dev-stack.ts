#!/usr/bin/env bun
/**
 * Local cloud-v2 dev stack — boots test-oem + core + audio as real listening
 * servers on fixed, simulator-reachable ports and STAYS UP. Use this to point
 * the real Mentra mobile app (iOS simulator) at a local cloud-v2.
 *
 * The iOS simulator shares the Mac's loopback, so `127.0.0.1` from the app
 * reaches these servers directly.
 *
 *   test-oem : http://127.0.0.1:3100   (mint OEM JWTs)
 *   core     : http://127.0.0.1:3000   (token exchange, REST)
 *   audio    : ws://127.0.0.1:3001/ws/session   (+ UDP :8000)
 *
 * Auth flow the mobile replicates (same as the test client):
 *   1. POST {testOem}/test-oem/mint-jwt  -> OEM JWT
 *   2. POST {core}/api/oem/oauth/token   -> v2 access token
 *   3. open ws://{audio}/ws/session?token=<access_token>
 *
 * Prereqs (same as the smoke test):
 *   - Local Mongo + Redis: `bun run setup:test`
 *   - For real transcripts: SONIOX_API_KEY in env and AUDIO_PROVIDER=soniox
 *     (run via `doppler run --config dev -- bun scripts/dev-stack.ts`).
 *     Defaults to the mock provider otherwise.
 *
 * On boot it runs a one-shot self-check of the full external flow (incl.
 * `?token=` query auth) and logs PASS/FAIL, then keeps serving.
 */

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { startCore } from "../packages/core/src/index";
import { startAudio } from "../packages/audio/src/index";
import { startTestOem } from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";

const PORT_CORE = Number(process.env.DEV_CORE_PORT ?? 3000);
const PORT_AUDIO_HTTP = Number(process.env.DEV_AUDIO_HTTP_PORT ?? 3001);
const PORT_AUDIO_UDP = Number(process.env.DEV_AUDIO_UDP_PORT ?? 8000);
const PORT_TEST_OEM = Number(process.env.DEV_TEST_OEM_PORT ?? 3100);
const OEM_ID = process.env.DEV_OEM_ID ?? "dev-local-oem";
const ADVERTISE_HOST = process.env.DEV_UDP_ADVERTISE_HOST ?? "127.0.0.1";

// Fresh Ed25519 keypair for this run, shared across core (signs) and audio
// (verifies). Set before shared/auth caches it. (Same pattern as the smoke.)
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
  process.env.REFRESH_TOKEN_PEPPER ??= "dev-stack-pepper";
  process.env.MONGO_URL ??= "mongodb://127.0.0.1:27017/cloud-v2-dev-stack";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/5";
}

const { resetMentraKeyCache } = await import("../packages/shared/src/auth");
const { resetSigningKeyCache } = await import(
  "../packages/core/src/services/session.service"
);
resetMentraKeyCache();
resetSigningKeyCache();

const provider = process.env.AUDIO_PROVIDER ?? "mock";
console.log("[dev-stack] booting test-oem, core, audio…");

const testOem = await startTestOem({ port: PORT_TEST_OEM, oemId: OEM_ID });
const core = await startCore({ port: PORT_CORE });
const audio = await startAudio({
  httpPort: PORT_AUDIO_HTTP,
  udpPort: PORT_AUDIO_UDP,
  udpAdvertisedHost: ADVERTISE_HOST,
  udpAdvertisedPort: PORT_AUDIO_UDP,
  workerCount: 1,
});

// Seed the OEM record so core trusts the test-oem's signing key on exchange.
await OemModel.deleteMany({ oemId: testOem.oemId });
await OemModel.create({
  oemId: testOem.oemId,
  displayName: "Local Dev OEM",
  publicKeyMode: "static",
  publicKey: `-----BEGIN PUBLIC KEY-----\n${testOem.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
});

console.log("");
console.log("[dev-stack] cloud-v2 is up:");
console.log(`  test-oem : ${testOem.url}`);
console.log(`  core     : ${core.url}`);
console.log(`  audio WS : ws://${ADVERTISE_HOST}:${PORT_AUDIO_HTTP}/ws/session`);
console.log(`  audio UDP: ${ADVERTISE_HOST}:${PORT_AUDIO_UDP}`);
console.log(`  provider : ${provider}`);
console.log(`  oemId    : ${testOem.oemId}`);
console.log("");

// === One-shot self-check: the exact external flow the mobile will run. ===
await selfCheck().catch((err) => {
  console.error("[dev-stack] self-check ERROR:", err);
});

console.log(
  "[dev-stack] ready. Point the app's backend at the URLs above. Ctrl-C to stop.",
);

// Keep the process alive.
await new Promise<never>(() => {});

// === Helpers ===

/** Mint an OEM JWT then exchange it at core for a v2 access token. */
async function mintAccessToken(oemUserId: string): Promise<string> {
  const mint = await fetch(`${testOem.url}/test-oem/mint-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oemUserId }),
  });
  if (!mint.ok) throw new Error(`mint-jwt failed: ${mint.status}`);
  const { jwt } = (await mint.json()) as { jwt: string };

  const ex = await fetch(`${core.url}/api/oem/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: jwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }),
  });
  if (!ex.ok) throw new Error(`token exchange failed: ${ex.status}`);
  const { access_token } = (await ex.json()) as { access_token: string };
  return access_token;
}

/**
 * Replicates the mobile's flow against the local stack, authenticating the
 * WS via `?token=` (the mobile's path), to confirm the cloud side is ready.
 */
async function selfCheck(): Promise<void> {
  const token = await mintAccessToken("dev-selfcheck-user");
  console.log(
    `[dev-stack] sample access token (1h):\n  ${token}\n`,
  );

  const wsUrl = `ws://${ADVERTISE_HOST}:${PORT_AUDIO_HTTP}/ws/session?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  const got = await new Promise<boolean>((resolve) => {
    let sessionTag = 0;
    const timer = setTimeout(() => resolve(false), 5000);
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : null;
      if (!raw) return;
      const msg = JSON.parse(raw) as { type: string; sessionTag?: number };
      if (msg.type === "CONNECTION_ACK") {
        sessionTag = msg.sessionTag ?? 0;
        console.log("[dev-stack] self-check: CONNECTION_ACK via ?token= OK");
        ws.send(
          JSON.stringify({
            type: "phone_subscription_update",
            subscriptions: ["transcription:en-US"],
            timestamp: new Date().toISOString(),
          }),
        );
        // For the mock provider, a binary audio frame yields a transcript we
        // can confirm round-trips as `data_stream`.
        if (provider === "mock") {
          setTimeout(() => {
            const pkt = Buffer.alloc(6 + 40);
            pkt.writeUInt32BE(sessionTag, 0);
            pkt.writeUInt16BE(0, 4);
            pkt.fill(0x42, 6);
            ws.send(pkt);
          }, 150);
        } else {
          // Real provider: connectivity + auth + subscribe is the bar here.
          clearTimeout(timer);
          resolve(true);
        }
      }
      if (msg.type === "data_stream") {
        clearTimeout(timer);
        console.log("[dev-stack] self-check: data_stream received OK");
        resolve(true);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });

  ws.close();
  console.log(`[dev-stack] self-check: ${got ? "PASS" : "FAIL"}`);
}
