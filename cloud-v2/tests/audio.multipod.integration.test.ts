/**
 * @fileoverview Multi-pod audio integration tests.
 *
 * Spawns TWO `cloud-audio` subprocesses (real OS processes, real port
 * bindings, isolated module state) plus one in-process core + test-oem.
 * Drives them through the cross-pod scenarios the architecture was designed
 * to handle:
 *
 *   - **Stateless ingress**: client WS-connects to pod A, then sends UDP to
 *     pod B. Pod B has no local knowledge of the session, resolves the
 *     sessionTag via Redis, XADDs to `audio:{userId}`. Verifies the bytes
 *     land in the stream regardless of which pod ingressed.
 *
 *   - **Cross-pod isolation**: two users on different pods don't cross-talk.
 *
 * Prereqs (same as audio.integration.test.ts): Mongo + Redis on default
 * ports. Uses fixed test ports — 13000, 13001, 13002 (HTTP/WS), 18001, 18002
 * (UDP), 13100 (test-oem).
 *
 * Run: `bun test tests/audio.multipod.integration.test.ts`
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

// === Env BEFORE imports (see audio.integration.test.ts for why) ===

// Ports are in a different range from audio.integration.test.ts so the two
// files can run in parallel without contention.
const CORE_PORT = 14000;
const POD_A_HTTP_PORT = 14001;
const POD_A_UDP_PORT = 18101;
const POD_B_HTTP_PORT = 14002;
const POD_B_UDP_PORT = 18102;
const TEST_OEM_PORT = 14100;
const TEST_OEM_ID = "test-oem";

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
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-multipod-test";
  // Different Redis DB from other test files so parallel runs don't conflict
  // on shared `audio:*` / `{user:*}:owner` keys. See audio.integration.test.ts.
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/2";
  // Deterministic offline transcript source: this suite tests cross-pod routing
  // and failover, not transcription. Propagated to spawned pods via process.env.
  process.env.AUDIO_PROVIDER ??= "mock";
  process.env.LOG_LEVEL ??= "warn";
}

import { startCore, type CoreHandle } from "../packages/core/src/index";
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
import { getOwner } from "../packages/runtime/src/services/session/ownership";
import {
  connectRedis,
  disconnectRedis,
  getRedis,
} from "../packages/runtime/src/clients/redis.client";
import { TestClient } from "../test/test-client/src/client";
import { spawnAudioPod, type PodHandle } from "./helpers/multipod";

let coreHandle: CoreHandle;
let testOemHandle: TestOemHandle;
let podA: PodHandle;
let podB: PodHandle;

// === Lifecycle ===

beforeAll(async () => {
  // Reset key caches that may be stale from a prior test file in the same
  // Bun test process. See audio.integration.test.ts for the explanation.
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

  // Connect this test process to Redis too — we use it for setup/teardown
  // and for asserting on stream contents.
  await connectRedis(process.env.REDIS_URL!);

  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);

  // Spawn the two audio pods. Each gets its own POD_ID for trace clarity.
  // Both share REDIS_URL + MENTRA_JWT_PUBLIC_KEY (inherited from this process).
  [podA, podB] = await Promise.all([
    spawnAudioPod({
      podId: "pod-a",
      httpPort: POD_A_HTTP_PORT,
      udpPort: POD_A_UDP_PORT,
      audioDebugEcho: true,
      captureOutput: process.env.DEBUG_PODS === "1",
    }),
    spawnAudioPod({
      podId: "pod-b",
      httpPort: POD_B_HTTP_PORT,
      udpPort: POD_B_UDP_PORT,
      audioDebugEcho: true,
      captureOutput: process.env.DEBUG_PODS === "1",
    }),
  ]);
}, 30_000);

afterAll(async () => {
  // Kill pods FIRST so they don't keep writing to Redis we're about to wipe.
  await Promise.all([podA?.kill(), podB?.kill()]);
  await disconnectRedis();
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

  const redis = getRedis();
  const audioKeys = await redis.keys("audio:*");
  const tagKeys = await redis.keys("sessionTag:*");
  const ownerKeys = await redis.keys("{user:*}:owner");
  if (audioKeys.length > 0) await redis.del(...audioKeys);
  if (tagKeys.length > 0) await redis.del(...tagKeys);
  if (ownerKeys.length > 0) await redis.del(...ownerKeys);
});

// === Tests ===

describe("audio multi-pod e2e", () => {
  test("stateless ingress: client WS on pod A, UDP to pod B, packet still lands in user's stream", async () => {
    const client = newClient(podA, "alice-cross");
    await client.connect();

    // Sanity: sessionTag is registered in Redis (cross-pod visibility).
    const tagRecord = await lookupSessionTagInRedis(client.sessionTag);
    expect(tagRecord).not.toBeNull();
    expect(tagRecord!.podId).toBe("pod-a");

    // Send the packet to POD B's UDP port — the "wrong" pod for this session.
    client.sendAudioTo(podB.udpAddr, new Uint8Array(40).fill(0x55));

    // Pod A would echo over its WS if the packet hit pod A. It didn't, so
    // we can't wait for an echo. Instead poll the stream directly.
    const userId = tagRecord!.mentraUserId;
    const redis = getRedis();
    const entries = await pollUntil(
      async () => {
        const e = await redis.xrange(audioStreamKey(userId), "-", "+");
        return e.length > 0 ? e : null;
      },
      2000,
    );
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    const [, fields] = entries![0]!;
    const map = fieldArrayToMap(fields);
    expect(map.seq).toBe("0");
    expect(Number(map.sessionTag)).toBe(client.sessionTag);

    await client.close();
  });

  test("cross-pod UDP liveness probe acks over the owner pod WS", async () => {
    const client = newClient(podA, "alice-cross-probe");
    await client.connect();

    const tagRecord = await lookupSessionTagInRedis(client.sessionTag);
    expect(tagRecord).not.toBeNull();
    expect(tagRecord!.podId).toBe("pod-a");

    client.sendUdpProbeTo(podB.udpAddr, "probe-cross-pod");

    const ack = (await client.waitFor("audio.udp_liveness_ack", 5000)) as {
      payload: {
        sessionId: string;
        sessionTag: number;
        probeId: string;
        receivedAt: number;
      };
    };
    expect(ack.payload.sessionTag).toBe(client.sessionTag);
    expect(ack.payload.probeId).toBe("probe-cross-pod");

    const redis = getRedis();
    const entries = await redis.xrange(audioStreamKey(tagRecord!.mentraUserId), "-", "+");
    expect(entries).toHaveLength(0);

    await client.close();
  });

  test("same-pod ingress still works alongside cross-pod", async () => {
    const client = newClient(podA, "alice-same");
    await client.connect();

    // Same-pod packet (default sendAudio uses the advertised host:port,
    // which is pod A's UDP port since the WS terminated on pod A).
    client.sendAudio(new Uint8Array(20));
    const echo = await client.waitFor("UDP_PACKET_RECEIVED");
    expect((echo as { sequence: number }).sequence).toBe(0);

    await client.close();
  });

  test("cross-pod isolation: two clients on different pods don't cross-talk", async () => {
    const clientA = newClient(podA, "alice-iso");
    const clientB = newClient(podB, "bob-iso");
    await Promise.all([clientA.connect(), clientB.connect()]);

    // Each client sends to its own pod (default).
    clientA.sendAudio(new Uint8Array(20).fill(0xaa));
    clientB.sendAudio(new Uint8Array(30).fill(0xbb));

    await Promise.all([
      clientA.waitFor("UDP_PACKET_RECEIVED"),
      clientB.waitFor("UDP_PACKET_RECEIVED"),
    ]);

    const tagA = await lookupSessionTagInRedis(clientA.sessionTag);
    const tagB = await lookupSessionTagInRedis(clientB.sessionTag);
    expect(tagA!.mentraUserId).not.toBe(tagB!.mentraUserId);
    expect(tagA!.podId).toBe("pod-a");
    expect(tagB!.podId).toBe("pod-b");

    const redis = getRedis();
    const aEntries = await redis.xrange(audioStreamKey(tagA!.mentraUserId), "-", "+");
    const bEntries = await redis.xrange(audioStreamKey(tagB!.mentraUserId), "-", "+");
    expect(aEntries.length).toBe(1);
    expect(bEntries.length).toBe(1);
    // Different streams, different entries.
    expect(fieldArrayToMap(aEntries[0]![1]).sessionTag).toBe(
      String(clientA.sessionTag),
    );
    expect(fieldArrayToMap(bEntries[0]![1]).sessionTag).toBe(
      String(clientB.sessionTag),
    );

    await Promise.all([clientA.close(), clientB.close()]);
  });

  test(
    "ownership is exclusive: same user can't be WS-bound to two pods",
    async () => {
      const clientA = newClient(podA, "alice-exclusive");
      await clientA.connect();

      const tagA = await lookupSessionTagInRedis(clientA.sessionTag);
      expect(tagA!.podId).toBe("pod-a");
      expect(await getOwner(tagA!.mentraUserId)).not.toBeNull();

      // Pod B's WS upgrade does `claimOwnershipWithRetry` (≈10s budget) and
      // then returns 409. We override the client's connect timeout so we
      // can actually wait for that 409 to arrive.
      const clientB = new TestClient({
        testOemUrl: testOemHandle.url,
        coreUrl: coreHandle.url,
        audioWsUrl: podB.wsUrl,
        tenantUserId: "alice-exclusive",
        connectTimeoutMs: 15_000,
      });

      let connectErr: Error | null = null;
      await clientB.connect().catch((e: Error) => {
        connectErr = e;
      });
      expect(connectErr).not.toBeNull();

      await clientA.close();
    },
    20_000,
  );

  test("ownership transfers cleanly after a pod releases", async () => {
    const clientA = newClient(podA, "alice-transfer");
    await clientA.connect();
    const userId = (await lookupSessionTagInRedis(clientA.sessionTag))!.mentraUserId;

    await clientA.close();
    // Allow the WS close handler's async releaseOwnership to land.
    await new Promise((r) => setTimeout(r, 200));

    expect(await getOwner(userId)).toBeNull();

    // Pod B can now claim cleanly.
    const clientB = newClient(podB, "alice-transfer");
    await clientB.connect();
    const ownerNow = await getOwner(userId);
    expect(ownerNow).toBe("pod-b");

    await clientB.close();
  });

  test("ownership transfers after pod death (TTL expiry)", async () => {
    // Pod A claims, then dies WITHOUT releasing.
    const clientA = newClient(podA, "alice-deadpod");
    await clientA.connect();
    const userId = (await lookupSessionTagInRedis(clientA.sessionTag))!.mentraUserId;
    expect(await getOwner(userId)).toBe("pod-a");

    // Hard-kill pod-a. The OS process disappears without running its
    // SIGTERM handler; the ownership key in Redis stays until TTL.
    podA.process.kill("SIGKILL");
    await podA.process.exited;

    // The claim should still be there immediately.
    expect(await getOwner(userId)).toBe("pod-a");

    // Pod B tries to claim while A's stale entry is still live → must
    // wait for TTL. Default claim-with-retry waits up to 2× TTL = 10s, so
    // this should succeed within the WS connect timeout.
    const clientB = new TestClient({
      testOemUrl: testOemHandle.url,
      coreUrl: coreHandle.url,
      audioWsUrl: podB.wsUrl,
      tenantUserId: "alice-deadpod",
      connectTimeoutMs: 15_000,
    });
    await clientB.connect();

    expect(await getOwner(userId)).toBe("pod-b");
    await clientB.close();

    // Respawn pod-a for the rest of the suite (afterAll will kill it cleanly).
    podA = await spawnAudioPod({
      podId: "pod-a",
      httpPort: POD_A_HTTP_PORT,
      udpPort: POD_A_UDP_PORT,
      audioDebugEcho: true,
    });
  }, 20_000);

  test("cross-pod full pipeline: UDP→pod-B→stream→pod-A worker→transcript back to pod-A WS", async () => {
    const client = newClient(podA, "alice-pipeline");
    await client.connect();

    // Send the packet to pod B's UDP port (deliberate cross-pod).
    client.sendAudioTo(podB.udpAddr, new Uint8Array(40).fill(0x77));

    // Expect the transcript to come back over pod A's WS (the user's WS pod)
    // even though pod B was the ingress pod.
    const ts = (await client.waitFor("TRANSCRIPT_STUB", 5000)) as {
      seq: number;
      origin: "live" | "replay";
    };
    expect(ts.seq).toBe(0);
    expect(ts.origin).toBe("live");

    await client.close();
  });

  test("cross-pod TRANSCRIPT: UDP to pod B, transcript delivered via pod A's WS", async () => {
    const client = newClient(podA, "alice-transcript-cross");
    await client.connect();
    client.subscribe([
      { kind: "transcription", language: { mode: "auto" } },
    ]);
    // subscribe() is a REST round-trip to the owner pod, then the worker
    // builds the provider — give both time before audio arrives cross-pod.
    await new Promise((r) => setTimeout(r, 400));

    client.sendAudioTo(podB.udpAddr, new Uint8Array(40).fill(0x44));

    const m = (await client.waitFor("stream.transcript", 5000)) as {
      payload: { provider: string; isFinal: boolean; text: string };
    };
    expect(m.payload.provider).toBe("mock");
    expect(m.payload.isFinal).toBe(true);
    expect(m.payload.text).toMatch(/^mock mu_[A-Z0-9]+:\S+ \d+$/);

    await client.close();
  });

  test("packet for unknown sessionTag at pod B is dropped (no crash)", async () => {
    // No client connect; just blast a packet with a junk tag at pod B.
    const sock = await Bun.udpSocket({});
    const pkt = Buffer.alloc(6 + 16);
    pkt.writeUInt32BE(0xdeadbeef, 0);
    pkt.writeUInt16BE(0, 4);
    sock.send(pkt, podB.udpPort, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 200));
    sock.close();

    // Both pods should still be healthy.
    const aHealth = await fetch(`${podA.url}/healthz`);
    const bHealth = await fetch(`${podB.url}/healthz`);
    expect(aHealth.ok).toBe(true);
    expect(bHealth.ok).toBe(true);
  });
});

// === Helpers ===

function newClient(pod: PodHandle, tenantUserId: string): TestClient {
  return new TestClient({
    testOemUrl: testOemHandle.url,
    coreUrl: coreHandle.url,
    audioWsUrl: pod.wsUrl,
    tenantUserId,
  });
}

function fieldArrayToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    out[fields[i]!] = fields[i + 1]!;
  }
  return out;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
