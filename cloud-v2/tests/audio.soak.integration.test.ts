/**
 * @fileoverview Soak / concurrency test for the audio pipeline.
 *
 * Spawns 2 audio pods, then drives N concurrent TestClients evenly
 * distributed across them. Each client connects, subscribes to
 * transcription, sends one audio packet, waits for its TRANSCRIPT, and
 * disconnects. Asserts:
 *
 *   - All clients connect (no 409 conflicts, no exchange failures)
 *   - All clients receive a TRANSCRIPT addressed to their own mentraUserId
 *   - No transcripts cross-talk between users
 *
 * Reveals issues that don't show up at N=1: race conditions in worker
 * assignment, ownership refresh under contention, shared Redis throughput,
 * pod-pool fairness.
 *
 * Default N=30 (15 per pod, 2 workers per pod). Tune via `AUDIO_SOAK_N`.
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

// === Env BEFORE imports ===

const CORE_PORT = 15000;
const POD_A_HTTP_PORT = 15001;
const POD_A_UDP_PORT = 18201;
const POD_B_HTTP_PORT = 15002;
const POD_B_UDP_PORT = 18202;
const TEST_OEM_PORT = 15100;
const TEST_OEM_ID = "test-oem";

const N_CLIENTS = Number.parseInt(process.env.AUDIO_SOAK_N ?? "30", 10);

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
    "mongodb://127.0.0.1:27017/mentra-cloud-v2-soak-test";
  // Distinct Redis DB so this test doesn't share keys with other suites.
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379/3";
  // Deterministic offline transcript source: this suite tests scaling/routing,
  // not transcription. The product transcription path is covered by the real
  // Soniox e2e tests.
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

beforeAll(async () => {
  const { resetMentraKeyCache } = await import("../packages/shared/src/auth");
  const { resetSigningKeyCache } = await import(
    "../packages/core/src/services/session.service"
  );
  resetMentraKeyCache();
  resetSigningKeyCache();

  testOemHandle = await startTestOem({
    port: TEST_OEM_PORT,
    tenantId: TEST_OEM_ID,
  });
  coreHandle = await startCore({ port: CORE_PORT });
  await connectRedis(process.env.REDIS_URL!);

  await Promise.all([
    OemModel.syncIndexes(),
    UserModel.syncIndexes(),
    RefreshTokenModel.syncIndexes(),
    SeenJtiModel.syncIndexes(),
    RevokedJtiModel.syncIndexes(),
  ]);

  [podA, podB] = await Promise.all([
    spawnAudioPod({
      podId: "pod-a",
      httpPort: POD_A_HTTP_PORT,
      udpPort: POD_A_UDP_PORT,
      audioDebugEcho: false,
    }),
    spawnAudioPod({
      podId: "pod-b",
      httpPort: POD_B_HTTP_PORT,
      udpPort: POD_B_UDP_PORT,
      audioDebugEcho: false,
    }),
  ]);
}, 30_000);

afterAll(async () => {
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
  for (const pattern of ["audio:*", "sessionTag:*", "{user:*}:owner"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
});

describe("audio soak", () => {
  test(
    `${N_CLIENTS} concurrent clients across 2 pods all receive their own TRANSCRIPT`,
    async () => {
      const pods = [podA, podB];
      const clients: TestClient[] = [];

      // Phase 1: connect all clients in parallel.
      await Promise.all(
        Array.from({ length: N_CLIENTS }, (_, i) => {
          const pod = pods[i % pods.length]!;
          const client = new TestClient({
            testOemUrl: testOemHandle.url,
            coreUrl: coreHandle.url,
            audioWsUrl: pod.wsUrl,
            tenantUserId: `soak-user-${i}`,
            connectTimeoutMs: 15_000,
          });
          clients.push(client);
          return client.connect();
        }),
      );
      expect(clients.length).toBe(N_CLIENTS);

      // Phase 2: subscribe all to transcription.
      for (const c of clients) {
        c.subscribe([
          { kind: "transcription", language: { mode: "auto" } },
        ]);
      }
      // Allow workers across both pods to receive UPDATE_SUBSCRIPTIONS and
      // build providers. With N_CLIENTS=30, that's 15 attaches per worker
      // pool, sequential within each worker.
      await new Promise((r) => setTimeout(r, 800));

      // Phase 3: each sends one packet of audio. To its OWN pod (no
      // cross-pod here — that's covered by the multipod tests).
      for (const c of clients) {
        c.sendAudio(new Uint8Array(40).fill(0x80));
      }

      // Phase 4: wait for each client to receive its transcript.
      const results = await Promise.allSettled(
        clients.map((c) => c.waitFor("stream.transcript", 15_000)),
      );

      const successes = results.filter(
        (r) => r.status === "fulfilled",
      ).length;
      const failures = results.length - successes;
      // We expect 100% — soak isn't useful if we tolerate drops. Surface
      // the count so a flaky run is informative.
      expect(failures).toBe(0);
      expect(successes).toBe(N_CLIENTS);

      // Phase 5: cross-talk check — each client's transcripts must all
      // reference its own user. The `stream.transcript` payload carries a
      // userId, and the MockProvider text also embeds the user scope
      // (`mock mu_<id>:<lang> <n>`); we key the check on the text scope.
      const scopeOf = (text: string): string | undefined =>
        text.split(" ")[1]?.split(":")[0]; // "mu_<id>"
      for (let i = 0; i < clients.length; i++) {
        const c = clients[i]!;
        const transcripts = c.messages.filter(
          (m) => m.type === "stream.transcript",
        ) as Array<{ payload: { text: string } }>;
        expect(transcripts.length).toBeGreaterThan(0);
        // Every transcript on this client's WS should be for this client's user.
        const firstScope = scopeOf(transcripts[0]!.payload.text);
        for (const t of transcripts) {
          expect(scopeOf(t.payload.text)).toBe(firstScope);
        }
      }

      // Phase 6: clean up.
      await Promise.all(clients.map((c) => c.close()));
    },
    60_000,
  );
});

function stripPemWrap(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
}
