#!/usr/bin/env bun
/**
 * Local cloud-v2 dev stack — boots test-oem + core + runtime as real listening
 * servers on fixed, simulator-reachable ports and STAYS UP. Use this to point
 * the real Mentra mobile app (iOS simulator) at a local cloud-v2.
 *
 * The iOS simulator shares the Mac's loopback, so `127.0.0.1` from the app
 * reaches these servers directly.
 *
 *   test-oem : http://127.0.0.1:3102   (mint OEM JWTs)
 *   core     : http://127.0.0.1:3000   (client auth, REST)
 *   auth     : http://127.0.0.1:3002   (local-dev runtime tokens)
 *   runtime  : ws://127.0.0.1:3001/ws/session   (+ UDP :8000)
 *
 * Auth flow the mobile replicates (same as the test client):
 *   1. POST {testOem}/test-oem/mint-jwt  -> OEM JWT
 *   2. POST {core}/api/client/auth/exchange -> v2 access token
 *   3. open ws://{runtime}/ws/session?token=<access_token>
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
import os from "node:os";
import { startCore } from "../packages/core/src/index";
import { startRuntime } from "../packages/runtime/src/index";
import { startTestOem } from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";
import { signRuntimeToken } from "../packages/shared/src/auth";

const PORT_CORE = Number(process.env.DEV_CORE_PORT ?? 3000);
const PORT_RUNTIME_HTTP = Number(
  process.env.DEV_RUNTIME_HTTP_PORT ?? process.env.DEV_AUDIO_HTTP_PORT ?? 3001,
);
const PORT_RUNTIME_UDP = Number(
  process.env.DEV_RUNTIME_UDP_PORT ?? process.env.DEV_AUDIO_UDP_PORT ?? 8000,
);
const PORT_TEST_OEM = Number(process.env.DEV_TEST_OEM_PORT ?? 3102);
const PORT_LOCAL_AUTH = Number(process.env.DEV_LOCAL_AUTH_PORT ?? 3002);
const OEM_ID = process.env.DEV_OEM_ID ?? "dev-local-oem";
const ADVERTISE_HOST = resolveAdvertiseHost();

const stripPem = (p: string) =>
  p
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");

// Fresh Ed25519 keypairs for this run. Core signs `cloud-core` tokens and can
// broker `cloud-runtime` tokens. The separate local auth issuer signs local-dev
// runtime-only tokens so Runtime never issues tokens for itself.
{
  const coreKeys = crypto.generateKeyPairSync("ed25519");
  const localRuntimeKeys = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_JWT_PRIVATE_KEY = stripPem(
    coreKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_JWT_PUBLIC_KEY = stripPem(
    coreKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.LOCAL_RUNTIME_AUTH_PRIVATE_KEY = stripPem(
    localRuntimeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.LOCAL_RUNTIME_AUTH_PUBLIC_KEY = stripPem(
    localRuntimeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  process.env.CLOUD_RUNTIME_AUTH_AUDIENCE ??= "cloud-runtime";
  process.env.CLOUD_RUNTIME_AUTH_ISSUERS ??= JSON.stringify([
    {
      issuer: "cloud-core",
      publicKeyEnv: "MENTRA_JWT_PUBLIC_KEY",
      userIdClaim: "sub",
      oemIdClaim: "oem_id",
    },
    {
      issuer: "local-dev-runtime",
      publicKeyEnv: "LOCAL_RUNTIME_AUTH_PUBLIC_KEY",
      userIdClaim: "sub",
      oemIdClaim: "oem_id",
    },
  ]);
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
// Worker threads read AUDIO_PROVIDER from process.env. If the user relies on
// the dev-stack default, make that default explicit before startRuntime().
process.env.AUDIO_PROVIDER = provider;
console.log("[dev-stack] booting test-oem, core, runtime…");

const testOem = await startTestOem({ port: PORT_TEST_OEM, oemId: OEM_ID });
const core = await startCore({ port: PORT_CORE });
const localAuth = startLocalAuthIssuer(PORT_LOCAL_AUTH);
const runtime = await startRuntime({
  httpPort: PORT_RUNTIME_HTTP,
  udpPort: PORT_RUNTIME_UDP,
  udpAdvertisedHost: ADVERTISE_HOST,
  udpAdvertisedPort: PORT_RUNTIME_UDP,
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
console.log(`  auth     : ${localAuth.url}`);
console.log(`  runtime WS : ws://${ADVERTISE_HOST}:${PORT_RUNTIME_HTTP}/ws/session`);
console.log(`  runtime UDP: ${ADVERTISE_HOST}:${PORT_RUNTIME_UDP}`);
console.log(`  provider : ${provider}`);
console.log(`  oemId    : ${testOem.oemId}`);
if (!process.env.DEV_UDP_ADVERTISE_HOST) {
  console.log("  udp host : auto-detected; override with DEV_UDP_ADVERTISE_HOST if needed");
}
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

/**
 * Pick a phone-reachable UDP host for local dev.
 *
 * TCP endpoints can be reached through adb reverse / simulator loopback, but
 * UDP cannot. Physical phones need the laptop's LAN address in connection.ack,
 * so defaulting to 127.0.0.1 makes Cloud V2 fall back to WebSocket audio.
 */
function resolveAdvertiseHost(): string {
  const explicit = process.env.DEV_UDP_ADVERTISE_HOST;
  if (explicit && explicit !== "auto") return explicit;

  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs ?? [])
      .filter((addr) => addr.family === "IPv4" && !addr.internal)
      .map((addr) => ({name, address: addr.address, score: scoreInterface(name, addr.address)})),
  );

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address ?? "127.0.0.1";
}

function scoreInterface(name: string, address: string): number {
  let score = 0;
  if (isPrivateIpv4(address)) score += 100;
  if (name === "en0" || name === "en1") score += 50;
  if (/^(bridge|docker|vboxnet|vmnet|awdl|llw|utun)/.test(name)) score -= 100;
  if (address.startsWith("169.254.")) score -= 50;
  return score;
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map((part) => Number(part));
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Mint a local-dev runtime token, bypassing Core to exercise runtime-only auth. */
async function mintRuntimeToken(oemUserId: string): Promise<string> {
  const res = await fetch(
    `${localAuth.url}/api/dev/runtime-token?` +
      new URLSearchParams({ userId: oemUserId, oemId: "dev-local-oem" }),
  );
  if (!res.ok) throw new Error(`dev runtime-token failed: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/**
 * Replicates the mobile's flow against the local stack, authenticating the
 * WS via `?token=` (the mobile's path), to confirm the cloud side is ready.
 */
async function selfCheck(): Promise<void> {
  const token = await mintRuntimeToken("dev-selfcheck-user");
  console.log(
    `[dev-stack] sample runtime token (15m):\n  ${token}\n`,
  );

  const wsUrl = `ws://${ADVERTISE_HOST}:${PORT_RUNTIME_HTTP}/ws/session?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  const got = await new Promise<boolean>((resolve) => {
    let sessionTag = 0;
    const timer = setTimeout(() => resolve(false), 5000);
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          v: 2,
          type: "connection.init",
          timestamp: Date.now(),
          payload: {
            protocolVersion: "2.0.0",
            audio: {
              codec: "lc3",
              sampleRate: 16000,
              initialSubscriptions: [
                {
                  kind: "transcription",
                  language: { mode: "auto" },
                },
              ],
            },
          },
        }),
      );
    };
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : null;
      if (!raw) return;
      const msg = JSON.parse(raw) as {
        type: string;
        payload?: { audio?: { sessionTag?: number } };
      };
      if (msg.type === "connection.ack") {
        sessionTag = msg.payload?.audio?.sessionTag ?? 0;
        console.log("[dev-stack] self-check: connection.ack via ?token= OK");
        // For the mock provider, a binary audio frame yields a transcript we
        // can confirm round-trips as a transcript result.
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
      if (msg.type === "stream.transcript") {
        clearTimeout(timer);
        console.log("[dev-stack] self-check: stream.transcript received OK");
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

function startLocalAuthIssuer(port: number): { url: string; stop(): void } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/dev/runtime-token") {
        return new Response("Not Found", { status: 404 });
      }

      const userId = url.searchParams.get("userId") || "local-dev-user";
      const oemId = url.searchParams.get("oemId") || "dev-local-oem";
      const token = await signRuntimeToken({
        privateKey: process.env.LOCAL_RUNTIME_AUTH_PRIVATE_KEY!,
        issuer: "local-dev-runtime",
        subject: userId,
        oemId,
        jti: crypto.randomUUID(),
        expiresInSeconds: 15 * 60,
        kid: "local-dev-runtime-1",
      });

      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: 15 * 60,
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop();
    },
  };
}
