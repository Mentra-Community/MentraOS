/**
 * @fileoverview Reconnect + re-handshake + subscription re-send, end to end.
 *
 * Boots real core + audio runtime against the local Mongo + Redis, then puts a
 * tiny WebSocket relay between the client and the audio server so the test can
 * drop the live socket DETERMINISTICALLY (no waiting on a flaky real network).
 * The flow proves recovery:
 *   1. Connect through the relay; the audio server runs the handshake and hands
 *      back sessionId A.
 *   2. setSubscriptions writes the set against session A (observable in Redis).
 *   3. The relay drops every connection. The client's reconnect-with-backoff
 *      opens a fresh socket, redoes the handshake (sessionId B), and re-sends the
 *      subscription set (Runtime.handleReopen -> Subscriptions.resend).
 *   4. We assert the Redis subscription record now carries sessionId B with the
 *      same set: a fresh PUT landed against the reconnected session, which is the
 *      observable proof the client re-handshook and re-sent.
 *
 * No Soniox: the proof is the re-sent subscription, not a resumed transcript, so
 * this runs offline. Needs Mongo at 127.0.0.1:27017 and Redis at 127.0.0.1:6379.
 *
 * Run with: bun test tests/cloud-client.reconnect.integration.test.ts
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { WebSocket } from "ws";

const TEST_OEM_ID = "test-oem";
const CORE_PORT = 13040;
const AUDIO_HTTP_PORT = 13041;
const AUDIO_UDP_PORT = 18040;
const TEST_OEM_PORT = 13140;
const RELAY_PORT = 13042;

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
  const miniapp = crypto.generateKeyPairSync("ed25519");
  process.env.MENTRA_MINIAPP_JWT_PRIVATE_KEY = stripPemWrap(
    miniapp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  process.env.MENTRA_MINIAPP_JWT_PUBLIC_KEY = stripPemWrap(
    miniapp.publicKey.export({ type: "spki", format: "pem" }).toString(),
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
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-cloudclient-reconnect-test";
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/6";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  process.env.AUDIO_PROVIDER = "mock";
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
import { readSubscriptions } from "../packages/runtime/src/services/session/subscriptions-store";
import { CloudClient } from "../packages/cloud-client/node";

let coreHandle: CoreHandle;
let audioHandle: AudioHandle;
let testOemHandle: TestOemHandle;
let relay: WsRelay;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    OemModel.createCollection(),
    UserModel.createCollection(),
    RefreshTokenModel.createCollection(),
    SeenJtiModel.createCollection(),
    RevokedJtiModel.createCollection(),
  ]);
  await Promise.all([
    syncIndexesIfCollectionExists(OemModel),
    syncIndexesIfCollectionExists(UserModel),
    syncIndexesIfCollectionExists(RefreshTokenModel),
    syncIndexesIfCollectionExists(SeenJtiModel),
    syncIndexesIfCollectionExists(RevokedJtiModel),
  ]);
  audioHandle = await startAudio({
    httpPort: AUDIO_HTTP_PORT,
    udpPort: AUDIO_UDP_PORT,
    udpAdvertisedHost: "127.0.0.1",
    udpAdvertisedPort: AUDIO_UDP_PORT,
  });
  relay = new WsRelay(RELAY_PORT, AUDIO_HTTP_PORT);
  await relay.start();
}, 30_000);

afterAll(async () => {
  await relay?.stop();
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

describe("cloud.runtime reconnect (real core + audio, relayed socket)", () => {
  test("recovers the session and re-sends subscriptions after a socket drop", async () => {
    const cloud = await newCloud("dave-reconnect");

    let disconnectedCount = 0;
    cloud.runtime.onDisconnected(() => {
      disconnectedCount += 1;
    });

    await cloud.runtime.connect();
    await cloud.auth.getCoreToken();
    const { mentraUserId } = cloud.auth.identity;

    await cloud.runtime.setSubscriptions([
      { kind: "transcription", language: { mode: "specific", code: "en" } },
    ]);

    // The set landed against the first session.
    const before = await waitForSubscriptionRecord(mentraUserId);
    expect(before).not.toBeNull();
    expect(before!.subscriptions.length).toBe(1);
    const sessionA = before!.sessionId;

    // Drop the socket: the relay severs both legs, so the client sees a close and
    // runs its reconnect-with-backoff path against a fresh upstream.
    relay.dropAll();

    // Wait until the subscription record carries a DIFFERENT sessionId, which
    // only happens once the client re-handshook (new audioSessionId) AND re-sent
    // the set against it.
    const after = await waitForSessionChange(mentraUserId, sessionA, 15_000);
    expect(after).not.toBeNull();
    expect(after!.sessionId).not.toBe(sessionA);
    expect(after!.subscriptions.length).toBe(1);
    expect((after!.subscriptions[0] as { kind: string }).kind).toBe("transcription");

    // The client observed the drop and surfaced it as a disconnect before
    // recovering (the reconnect's re-send above is the recovery proof; a
    // reconnect intentionally does not re-emit `connected`).
    expect(disconnectedCount).toBeGreaterThanOrEqual(1);

    cloud.runtime.close();
    await sleep(200);
  }, 40_000);
});

// === Helpers ===

async function syncIndexesIfCollectionExists(model: { syncIndexes(): Promise<unknown> }) {
  try {
    await model.syncIndexes();
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === 26) {
      return;
    }
    throw err;
  }
}

async function newCloud(tenantUserId: string): Promise<CloudClient> {
  const mintRes = await fetch(`${testOemHandle.url}/test-oem/mint-jwt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantUserId }),
  });
  if (!mintRes.ok) throw new Error(`mint-jwt failed: ${mintRes.status}`);
  const { jwt } = (await mintRes.json()) as { jwt: string };

  return new CloudClient({
    // The runtime endpoint is the relay: it proxies REST through to the audio
    // server unchanged AND relays the WebSocket, so the test can drop just the
    // live socket on demand while subscription PUTs still reach the real server.
    // The runtime derives the ws URL from this (http -> ws, + /ws/session).
    endpoints: { core: coreHandle.url, runtime: `http://localhost:${RELAY_PORT}` },
    auth: {
      core: { subjectToken: jwt, subjectTokenType: "oem-jwt" },
      // Broker the runtime token from Core (mobile uses the same path); the
      // runtime trusts the cloud-core issuer via CLOUD_RUNTIME_AUTH_ISSUERS.
      runtime: { source: "core" },
    },
    audio: { codec: "pcm", sampleRate: 16000 },
    // Fast, jitter-free backoff so the reconnect happens within the test window.
    reconnect: { baseMs: 50, maxMs: 200, jitter: false },
  });
}

/**
 * Poll the Redis subscription record until it exists (the seed plus the client's
 * REST write have landed).
 */
async function waitForSubscriptionRecord(
  mentraUserId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readSubscriptions(mentraUserId);
    if (rec && rec.subscriptions.length > 0) return rec;
    await sleep(50);
  }
  return readSubscriptions(mentraUserId);
}

/**
 * Poll until the subscription record's sessionId differs from `previousSessionId`
 * and the set is non-empty: the signal that the reconnect re-handshook and
 * re-sent.
 */
async function waitForSessionChange(
  mentraUserId: string,
  previousSessionId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readSubscriptions(mentraUserId);
    if (
      rec &&
      rec.sessionId !== previousSessionId &&
      rec.subscriptions.length > 0
    ) {
      return rec;
    }
    await sleep(50);
  }
  return readSubscriptions(mentraUserId);
}

/** Per-relayed-socket state Bun stashes on the server-side WebSocket. */
interface RelaySocketData {
  /** The upstream connection to the real audio server for this client socket. */
  upstream: WebSocket;
  /** Client frames buffered until the upstream finishes connecting. */
  pending: Array<string | Uint8Array>;
  upstreamOpen: boolean;
}

/**
 * A WebSocket + HTTP relay between the client and the audio server.
 *
 * REST requests (the subscription PUT) are proxied through to the audio server
 * unchanged. A `/ws/session` upgrade is accepted and bridged to a fresh upstream
 * WebSocket to the audio server, preserving the `?token=` query so the
 * handshake reaches the server as if direct. `dropAll()` force-closes every live
 * bridge so the client sees a socket close and runs its reconnect path.
 */
class WsRelay {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly live = new Set<ServerWebSocket<RelaySocketData>>();

  constructor(
    private readonly port: number,
    private readonly upstreamPort: number,
  ) {}

  start(): Promise<void> {
    const upstreamPort = this.upstreamPort;
    const live = this.live;
    this.server = Bun.serve<RelaySocketData>({
      port: this.port,
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws/session") {
          // Open the upstream first so it is ready to receive the handshake the
          // moment the client socket opens.
          const upstream = new WebSocket(
            `ws://localhost:${upstreamPort}${url.pathname}${url.search}`,
          );
          const ok = srv.upgrade(req, {
            data: { upstream, pending: [], upstreamOpen: false },
          });
          if (ok) return undefined;
          upstream.close();
          return new Response("upgrade failed", { status: 426 });
        }
        // Proxy every non-WS request straight to the audio server.
        const target = `http://localhost:${upstreamPort}${url.pathname}${url.search}`;
        return fetch(target, {
          method: req.method,
          headers: req.headers,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : await req.arrayBuffer(),
        });
      },
      websocket: {
        open(ws) {
          live.add(ws);
          const { upstream } = ws.data;
          upstream.on("open", () => {
            ws.data.upstreamOpen = true;
            for (const data of ws.data.pending) upstream.send(data);
            ws.data.pending.length = 0;
          });
          upstream.on("message", (data: Buffer) => {
            // ws-package frames arrive as Buffer; forward as-is to the client.
            ws.send(data);
          });
          upstream.on("close", () => {
            try {
              ws.close();
            } catch {
              // already closing
            }
          });
          upstream.on("error", () => {
            try {
              ws.close();
            } catch {
              // already closing
            }
          });
        },
        message(ws, message) {
          const { upstream } = ws.data;
          const frame =
            typeof message === "string" ? message : new Uint8Array(message);
          if (ws.data.upstreamOpen) upstream.send(frame);
          else ws.data.pending.push(frame);
        },
        close(ws) {
          live.delete(ws);
          try {
            ws.data.upstream.close();
          } catch {
            // already closing
          }
        },
      },
    });
    return Promise.resolve();
  }

  /** Force-close every live bridge so the client sees a drop and reconnects. */
  dropAll(): void {
    for (const ws of [...this.live]) {
      this.live.delete(ws);
      try {
        ws.data.upstream.terminate();
      } catch {
        // already gone
      }
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
  }

  stop(): Promise<void> {
    this.dropAll();
    this.server?.stop(true);
    return Promise.resolve();
  }
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
