/**
 * @fileoverview End-to-end audio path integration test.
 *
 * Spins up the full local stack in-process — TEST OEM, core, audio — then
 * drives the same handshake a real mobile client would:
 *
 *   1. TestClient mints OEM JWT from TEST OEM
 *   2. Exchanges at core for a Mentra access token
 *   3. Opens WS to audio, sends connection.init, receives connection.ack
 *      with sessionTag + UDP info
 *   4. Sends a UDP packet
 *   5. Audio echoes back UDP_PACKET_RECEIVED (debug-echo mode)
 *
 * Prereqs:
 *   - A running Mongo at `MONGO_URL` (default mongodb://127.0.0.1:27017).
 *     We use a test-only database name; collections are dropped each test.
 *   - A running Redis at `REDIS_URL` (default redis://127.0.0.1:6379).
 *
 * Run: `bun test tests/audio.integration.test.ts`
 *
 * Uses fixed test ports (13000/13001/13100, UDP 18000) to avoid stepping on
 * the dev environment's defaults.
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
const CORE_PORT = 13000;
const AUDIO_HTTP_PORT = 13001;
const AUDIO_UDP_PORT = 18000;
const TEST_OEM_PORT = 13100;

// === Env setup BEFORE any package imports ===
// session.service.ts reads AUDIO_UDP_ADVERTISED_{HOST,PORT} at module-load
// time to bake into connection.ack responses. So these MUST be set before
// the import below.
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
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-audio-test";
  // Each test file gets its own Redis DB so parallel runs don't stomp each
  // other's keys. (Redis defaults to 16 DBs — plenty for our suites.)
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/1";
  process.env.AUDIO_UDP_ADVERTISED_HOST = "127.0.0.1";
  process.env.AUDIO_UDP_ADVERTISED_PORT = String(AUDIO_UDP_PORT);
  // Deterministic offline transcript source: this suite tests the audio routing
  // pipeline, not transcription (which the real Soniox e2e tests cover).
  process.env.AUDIO_PROVIDER ??= "mock";
  // Audio echoes UDP_PACKET_RECEIVED over the WS so the test can assert receipt.
  process.env.AUDIO_DEBUG_ECHO = "true";
  // Quiet down the per-test log spam.
  process.env.LOG_LEVEL ??= "info";
}

import { startCore, type CoreHandle } from "../packages/core/src/index";
import { startAudio, type AudioHandle } from "../packages/runtime/src/index";
import {
  startTestOem,
  type TestOemHandle,
} from "../test/test-oem/src/index";
import { OemModel } from "../packages/core/src/models/oem.model";
import { UserModel } from "../packages/core/src/models/user.model";
import { RefreshTokenModel } from "../packages/core/src/models/refresh-token.model";
import { SeenJtiModel } from "../packages/core/src/models/seen-jti.model";
import { RevokedJtiModel } from "../packages/core/src/models/revoked-jti.model";
import {
  audioStreamKey,
  lookupSessionTagInRedis,
} from "../packages/runtime/src/services/session/stream";
import { readSubscriptions } from "../packages/runtime/src/services/session/subscriptions-store";
import { hasLiveAudioSession } from "../packages/runtime/src/net/ws";
import {
  getOwner,
  tryClaimOwnership,
  refreshOwnership,
  releaseOwnership,
} from "../packages/runtime/src/services/session/ownership";
import { getRedis } from "../packages/runtime/src/clients/redis.client";
import { TestClient } from "../test/test-client/src/client";

let coreHandle: CoreHandle;
let audioHandle: AudioHandle;
let testOemHandle: TestOemHandle;

// === Test lifecycle ===

beforeAll(async () => {
  // If another test file already ran in this same Bun test process, its
  // Mentra keypair is cached in shared/auth and core/session.service. We
  // generated a fresh keypair above; reset the caches so the next sign/verify
  // reads our env values instead of the prior file's.
  const { resetMentraKeyCache } = await import(
    "../packages/shared/src/auth"
  );
  const { resetSigningKeyCache } = await import(
    "../packages/core/src/services/session.service"
  );
  resetMentraKeyCache();
  resetSigningKeyCache();

  testOemHandle = await startTestOem({ port: TEST_OEM_PORT, tenantId: TEST_OEM_ID });
  coreHandle = await startCore({ port: CORE_PORT });

  // Wait for index sync so the seen-jti replay index actually fires.
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
  // Clear audio streams + sessionTag registrations + ownership claims so
  // assertions don't see leftover state from prior tests.
  const redis = getRedis();
  const keys = await redis.keys("audio:*");
  const tagKeys = await redis.keys("sessionTag:*");
  const ownerKeys = await redis.keys("{user:*}:owner");
  if (keys.length > 0) await redis.del(...keys);
  if (tagKeys.length > 0) await redis.del(...tagKeys);
  if (ownerKeys.length > 0) await redis.del(...ownerKeys);
  // Seed the TEST OEM record so core trusts JWTs signed by it.
  await OemModel.create({
    tenantId: TEST_OEM_ID,
    displayName: "Test OEM",
    publicKeyMode: "static",
    publicKey: `-----BEGIN PUBLIC KEY-----\n${testOemHandle.keypair.publicKeyBody}\n-----END PUBLIC KEY-----`,
  });
});

// === Tests ===

describe("audio e2e", () => {
  test("handshake: connection.init yields connection.ack with UDP info", async () => {
    const client = newClient("alice-handshake");
    await client.connect();

    expect(client.connected).toBe(true);
    expect(client.sessionTag).toBeGreaterThan(0);

    const ack = client.messages.find((m) => m.type === "connection.ack") as
      | { payload: { audio?: { udp: { host: string; port: number } } } }
      | undefined;
    expect(ack).toBeDefined();
    expect(ack!.payload.audio!.udp.host).toBe("127.0.0.1");
    expect(ack!.payload.audio!.udp.port).toBe(AUDIO_UDP_PORT);

    await client.close();
  });

  test("UDP packet round-trip: sendAudio → cloud receives → debug echo", async () => {
    const client = newClient("alice-udp");
    await client.connect();

    const payload = new Uint8Array(40).fill(0x42);
    client.sendAudio(payload);

    const echo = (await client.waitFor("UDP_PACKET_RECEIVED")) as {
      type: "UDP_PACKET_RECEIVED";
      sequence: number;
      payloadLen: number;
    };
    expect(echo.sequence).toBe(0);
    expect(echo.payloadLen).toBe(40);

    await client.close();
  });

  test("UDP liveness probe acks over WS and does not enter audio stream", async () => {
    const client = newClient("alice-udp-probe");
    await client.connect();

    client.sendUdpProbe("probe-1");

    const ack = (await client.waitFor("audio.udp_liveness_ack")) as {
      payload: {
        sessionId: string;
        sessionTag: number;
        probeId: string;
        receivedAt: number;
      };
    };
    expect(ack.payload.sessionTag).toBe(client.sessionTag);
    expect(ack.payload.probeId).toBe("probe-1");

    const tagRecord = await lookupSessionTagInRedis(client.sessionTag);
    expect(tagRecord).not.toBeNull();
    const redis = getRedis();
    const entries = await redis.xrange(audioStreamKey(tagRecord!.mentraUserId), "-", "+");
    expect(entries).toHaveLength(0);

    await client.close();
  });

  test("sequence increments across packets", async () => {
    const client = newClient("alice-seq");
    await client.connect();

    for (let i = 0; i < 3; i++) {
      client.sendAudio(new Uint8Array(20));
    }

    // Wait long enough for all three echoes to come back.
    await new Promise((r) => setTimeout(r, 200));

    const echoes = client.messages.filter(
      (m) => m.type === "UDP_PACKET_RECEIVED",
    ) as Array<{ sequence: number }>;
    expect(echoes).toHaveLength(3);
    expect(echoes.map((e) => e.sequence)).toEqual([0, 1, 2]);

    await client.close();
  });

  test("packet lands in user's Redis Stream", async () => {
    const client = newClient("alice-stream");
    await client.connect();

    const payload = new Uint8Array(40).fill(0x99);
    client.sendAudio(payload);

    // Wait for the echo so we know the XADD completed (echo fires after XADD).
    await client.waitFor("UDP_PACKET_RECEIVED");

    // Resolve userId from the sessionTag via Redis (we don't have it directly
    // in the client; this also exercises the Redis registry path).
    const tagRecord = await lookupSessionTagInRedis(client.sessionTag);
    expect(tagRecord).not.toBeNull();
    const userId = tagRecord!.mentraUserId;

    const redis = getRedis();
    const entries = await redis.xrange(audioStreamKey(userId), "-", "+");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const [, fields] = entries[0]!;
    // ioredis returns fields as a flat [field, value, field, value] array.
    const map = fieldArrayToMap(fields);
    expect(map.seq).toBe("0");
    expect(Number(map.sessionTag)).toBe(client.sessionTag);

    await client.close();
  });

  test("sessionTag is registered in Redis on WS open, deleted on close", async () => {
    const client = newClient("alice-registry");
    await client.connect();

    const before = await lookupSessionTagInRedis(client.sessionTag);
    expect(before).not.toBeNull();
    expect(before!.mentraUserId).toMatch(/^mu_/);

    const tagSnapshot = client.sessionTag;
    await client.close();
    // Give the WS close handler a beat to fire its async cleanup.
    await new Promise((r) => setTimeout(r, 100));

    const after = await lookupSessionTagInRedis(tagSnapshot);
    expect(after).toBeNull();
  });

  test("same auth-session reconnect takes over subscriptions immediately", async () => {
    const client = newClient("alice-same-auth-reconnect");
    const subscriptions = [
      {
        kind: "transcription" as const,
        language: { mode: "auto" as const },
      },
    ];
    client.subscribe(subscriptions);
    await client.connect();

    const firstSessionId = client.sessionId;
    const firstTag = client.sessionTag;
    const tagRecord = await lookupSessionTagInRedis(firstTag);
    expect(tagRecord).toBeDefined();
    const mentraUserId = tagRecord!.mentraUserId;
    expect((await readSubscriptions(mentraUserId))?.sessionId).toBe(
      firstSessionId,
    );

    await client.reconnectWithoutClosingPreviousForTest();

    const secondSessionId = client.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(hasLiveAudioSession(mentraUserId, firstSessionId)).toBe(false);
    expect(hasLiveAudioSession(mentraUserId, secondSessionId)).toBe(true);
    expect((await readSubscriptions(mentraUserId))?.sessionId).toBe(
      secondSessionId,
    );

    await client.close();
  });

  test("same user reconnect with fresh auth takes over subscriptions immediately", async () => {
    const client = newClient("alice-fresh-auth-reconnect");
    const subscriptions = [
      {
        kind: "transcription" as const,
        language: { mode: "auto" as const },
      },
    ];
    client.subscribe(subscriptions);
    await client.connect();

    const firstSessionId = client.sessionId;
    const firstTag = client.sessionTag;
    const tagRecord = await lookupSessionTagInRedis(firstTag);
    expect(tagRecord).toBeDefined();
    const mentraUserId = tagRecord!.mentraUserId;
    expect((await readSubscriptions(mentraUserId))?.sessionId).toBe(
      firstSessionId,
    );

    await client.reconnectWithFreshAuthWithoutClosingPreviousForTest();

    const secondSessionId = client.sessionId;
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(hasLiveAudioSession(mentraUserId, firstSessionId)).toBe(false);
    expect(hasLiveAudioSession(mentraUserId, secondSessionId)).toBe(true);
    expect((await readSubscriptions(mentraUserId))?.sessionId).toBe(
      secondSessionId,
    );

    await client.close();
  });

  test("ws responds to control.ping with control.pong", async () => {
    const client = newClient("alice-ping");
    await client.connect();

    // Probe the underlying WS directly with a v2 control.ping.
    const ws = (client as unknown as { ws: WebSocket }).ws;
    expect(ws).toBeTruthy();

    let pongSeen = false;
    const oldOnMessage = ws.onmessage;
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        try {
          const parsed = JSON.parse(ev.data);
          if (parsed?.type === "control.pong") pongSeen = true;
        } catch { /* ignore */ }
      }
      oldOnMessage?.call(ws, ev);
    };

    ws.send(
      JSON.stringify({
        v: 2,
        type: "control.ping",
        timestamp: Date.now(),
        payload: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(pongSeen).toBe(true);

    await client.close();
  });

  test("idle WS is NOT killed by the cloud (liveness is the client's job)", async () => {
    // The point: cloud-v2 must not close an idle WS. We connect, send no
    // audio, send no pings, sit for a few seconds, and verify the WS is
    // still open (readyState 1 = OPEN). v1 spent weeks debugging
    // nginx-side timeouts that killed silent WSs — see
    // docs/issues/003-audio/design.md "Cloud is passive on connection liveness".
    const client = newClient("alice-idle");
    await client.connect();
    const ws = (client as unknown as { ws: WebSocket }).ws;

    await new Promise((r) => setTimeout(r, 3000));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    await client.close();
  }, 10_000);

  test("WS-binary audio fallback works (same wire format as UDP)", async () => {
    const client = newClient("alice-ws-audio");
    await client.connect();
    client.subscribe([
      { kind: "transcription", language: { mode: "auto" } },
    ]);
    await new Promise((r) => setTimeout(r, 150));

    // Send via WS binary instead of UDP. Same 6-byte header + payload.
    client.sendAudioWs(new Uint8Array(40).fill(0x55));

    const m = (await client.waitFor("stream.transcript", 5000)) as {
      payload: { text: string; subscription: { kind: string } };
    };
    expect(m.payload.subscription.kind).toBe("transcription");
    expect(m.payload.text).toMatch(/^mock mu_[A-Z0-9]+:\S+ \d+$/);

    await client.close();
  });

  test("packet flows UDP → stream → worker → LC3 decode → TRANSCRIPT_STUB", async () => {
    const client = newClient("alice-fullpath");
    await client.connect();

    // 40 bytes of LC3 = 2 frames @ 20 bytes/frame (16kbps default).
    // Each frame decodes to 160 samples Int16 = 320 bytes PCM.
    // Expected pcmBytesLen = 2 × 320 = 640 bytes.
    client.sendAudio(new Uint8Array(40).fill(0x42));

    const ts = (await client.waitFor("TRANSCRIPT_STUB", 5000)) as {
      type: "TRANSCRIPT_STUB";
      seq: number;
      payloadLen: number;
      pcmBytesLen: number;
      origin: "live" | "replay";
    };
    expect(ts.seq).toBe(0);
    expect(ts.payloadLen).toBe(40);
    expect(ts.pcmBytesLen).toBe(640);
    expect(ts.origin).toBe("live");

    await client.close();
  });

  test("provider emits TRANSCRIPT after PCM reaches the worker (mock)", async () => {
    const client = newClient("alice-transcribe");
    await client.connect();
    client.subscribe([
      { kind: "transcription", language: { mode: "auto" } },
    ]);
    // Give the worker a beat to receive the UPDATE_SUBSCRIPTIONS message
    // before sending audio. Without this, the audio might decode before
    // the provider exists → no transcript.
    await new Promise((r) => setTimeout(r, 100));

    client.sendAudio(new Uint8Array(40).fill(0x42));

    const m = (await client.waitFor("stream.transcript", 5000)) as {
      payload: { text: string; isFinal: boolean; provider: string };
    };
    expect(m.payload.provider).toBe("mock");
    expect(m.payload.isFinal).toBe(true);
    // MockProvider format: `mock <scope> <n>`, scope = `mu_…:<lang>`.
    expect(m.payload.text).toMatch(/^mock mu_[A-Z0-9]+:\S+ \d+$/);

    await client.close();
  });

  test("no subscription = no TRANSCRIPT (TRANSCRIPT_STUB still fires)", async () => {
    const client = newClient("alice-no-sub");
    await client.connect();
    // Deliberately NO subscribe(...) call.
    client.sendAudio(new Uint8Array(40).fill(0x42));

    // Stub fires (proves decode happened) but no TRANSCRIPT should come.
    await client.waitFor("TRANSCRIPT_STUB", 3000);
    await new Promise((r) => setTimeout(r, 500));
    const transcripts = client.messages.filter(
      (m) => m.type === "stream.transcript" || m.type === "stream.translation",
    );
    expect(transcripts.length).toBe(0);

    await client.close();
  });

  test("translation subscription produces TRANSCRIPT kind='translation'", async () => {
    const client = newClient("alice-translate");
    await client.connect();
    client.subscribe([
      {
        kind: "translation",
        source: { mode: "auto" },
        target: "es",
      },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    client.sendAudio(new Uint8Array(40).fill(0x77));

    const m = (await client.waitFor("stream.translation", 5000)) as {
      payload: {
        text: string;
        source: { language: string };
        target: { language: string };
        subscription: { kind: string; target: string };
      };
    };
    expect(m.payload.subscription.kind).toBe("translation");
    expect(m.payload.target.language).toBe("es"); // target
    expect(m.payload.source.language).toBe("auto");

    await client.close();
  });

  test("transcription + translation can run concurrently for one user", async () => {
    const client = newClient("alice-both");
    await client.connect();
    client.subscribe([
      { kind: "transcription", language: { mode: "auto" } },
      { kind: "translation", source: { mode: "auto" }, target: "fr" },
    ]);
    // More generous wait: handleUpdateSubscriptions creates providers
    // sequentially (LC3Decoder.create + provider construct), and on the
    // shared Redis instance the dispatch loop runs against contention from
    // other tests. 300ms covers worst-case provider readiness.
    await new Promise((r) => setTimeout(r, 300));
    client.sendAudio(new Uint8Array(40).fill(0xab));

    // Wait until BOTH transcripts arrive (or timeout). Mock provider emits
    // one per writeAudio, so two providers = two outputs. Both run in the
    // same worker, processing happens in order — first arrives quickly,
    // second arrives in the same tick.
    const deadline = Date.now() + 5000;
    const seen = new Set<string>();
    while (Date.now() < deadline && seen.size < 2) {
      for (const m of client.messages) {
        if (m.type === "stream.transcript" || m.type === "stream.translation") {
          seen.add(m.type);
        }
      }
      if (seen.size < 2) await new Promise((r) => setTimeout(r, 50));
    }

    expect(seen.has("stream.transcript")).toBe(true);
    expect(seen.has("stream.translation")).toBe(true);
    const trans = client.messages.find(
      (m) => m.type === "stream.translation",
    ) as { payload: { target: { language: string } } } | undefined;
    expect(trans?.payload.target.language).toBe("fr");

    await client.close();
  });

  test("specific-language transcription subscription is honored", async () => {
    const client = newClient("alice-en-us");
    await client.connect();
    client.subscribe([
      { kind: "transcription", language: { mode: "specific", code: "en-US" } },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    client.sendAudio(new Uint8Array(40).fill(0x55));

    const m = (await client.waitFor("stream.transcript", 5000)) as {
      payload: {
        resolvedLanguage: string;
        subscription: { language: { code?: string } };
      };
    };
    expect(m.payload.resolvedLanguage).toBe("en-US");
    expect(m.payload.subscription.language.code).toBe("en-US");

    await client.close();
  });

  test("ownership claim is set on WS open and released on close", async () => {
    const client = newClient("alice-owner");
    await client.connect();

    const tagRecord = await lookupSessionTagInRedis(client.sessionTag);
    expect(tagRecord).not.toBeNull();
    const userId = tagRecord!.mentraUserId;

    // Owner is set, points at this pod.
    const ownerWhileOpen = await getOwner(userId);
    expect(ownerWhileOpen).not.toBeNull();

    await client.close();
    await new Promise((r) => setTimeout(r, 100));

    const ownerAfterClose = await getOwner(userId);
    expect(ownerAfterClose).toBeNull();
  });

  test("WS rejects missing Authorization", async () => {
    const ws = new WebSocket(audioHandle.wsUrl);
    const closed = await new Promise<{ code: number }>((resolve) => {
      ws.onclose = (ev) => resolve({ code: ev.code });
      ws.onerror = () => resolve({ code: -1 });
    });
    // Bun closes the WS with a 1006-ish abnormal code on rejected upgrade,
    // but the upgrade itself returned 401 over HTTP. Either way the WS
    // never opened — that's the assertion.
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    expect(closed.code).not.toBe(1000);
  });

  test("packet for unknown sessionTag is silently dropped", async () => {
    // Open a UDP socket and fire a packet with a junk tag; nothing should
    // crash and no echo should ever come back to any client.
    const client = newClient("alice-junk");
    await client.connect();

    const sock = await Bun.udpSocket({});
    const pkt = Buffer.alloc(6 + 16);
    pkt.writeUInt32BE(0xdeadbeef, 0);
    pkt.writeUInt16BE(0, 4);
    sock.send(pkt, AUDIO_UDP_PORT, "127.0.0.1");

    await new Promise((r) => setTimeout(r, 150));
    // No UDP_PACKET_RECEIVED should land on the connected client.
    const echoes = client.messages.filter(
      (m) => m.type === "UDP_PACKET_RECEIVED",
    );
    expect(echoes).toHaveLength(0);

    sock.close();
    await client.close();
  });
});

// === Helpers ===

function newClient(tenantUserId: string): TestClient {
  return new TestClient({
    testOemUrl: testOemHandle.url,
    coreUrl: coreHandle.url,
    audioWsUrl: audioHandle.wsUrl,
    tenantUserId,
  });
}

describe("ownership primitives", () => {
  test("claim succeeds on empty, blocks for other pod, idempotent for same pod", async () => {
    const u = "mu_test_primitive_1";
    expect(await tryClaimOwnership(u, "pod-a")).toBe("claimed");
    expect(await tryClaimOwnership(u, "pod-a")).toBe("already-ours");
    expect(await tryClaimOwnership(u, "pod-b")).toBe("owned-by-other");
  });

  test("refresh only when we own", async () => {
    const u = "mu_test_primitive_2";
    expect(await tryClaimOwnership(u, "pod-a")).toBe("claimed");
    expect(await refreshOwnership(u, "pod-a")).toBe(true);
    expect(await refreshOwnership(u, "pod-b")).toBe(false);
  });

  test("release only when we own", async () => {
    const u = "mu_test_primitive_3";
    expect(await tryClaimOwnership(u, "pod-a")).toBe("claimed");
    expect(await releaseOwnership(u, "pod-b")).toBe(false);
    expect(await getOwner(u)).toBe("pod-a");
    expect(await releaseOwnership(u, "pod-a")).toBe(true);
    expect(await getOwner(u)).toBeNull();
  });
});

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}

function fieldArrayToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[fields[i]!] = fields[i + 1]!;
  }
  return out;
}
