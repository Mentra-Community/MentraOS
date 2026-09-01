/**
 * `@mentra/cloud-runtime` — Mentra Runtime Services. Audio (UDP ingress, workers,
 * Redis-routed ownership, transcription + translation providers) is the first
 * service; streaming and photo land here too.
 *
 * Boot order:
 *   1. Connect Redis (main + streams clients).
 *   2. Start UDP listener on `udpPort`.
 *   3. Start Bun.serve for HTTP health + WS session.
 *   4. (Pending) Worker pool, ownership refresh.
 *
 * When imported, nothing runs — call `startRuntime(...)`. When executed
 * directly, the bottom block drives boot from env vars.
 *
 * Spec + design: cloud-v2/docs/issues/002-cloud-runtime/.
 */

import {
  assertRuntimeAuthConfigured,
  createLogger,
} from "@mentra/cloud-shared";
import {
  connectRedis,
  disconnectRedis,
  redisReadinessCheck,
} from "./clients/redis.client";
import os from "node:os";
import {
  configureAudioSession,
  dropUserSessionsForLostOwnership,
  forwardToUserSessions,
  getOwnedUserIds,
  getPodId,
  HTTP_FALLTHROUGH,
  tryWsUpgrade,
  wsHandlers,
} from "./net/ws";
import { startUdpIngress, stopUdpIngress } from "./net/udp";
import { createApiApp } from "./api";
import {
  startOwnershipRefreshLoop,
  stopOwnershipRefreshLoop,
} from "./services/session/ownership";
import {
  startStreamSweepLoop,
  stopStreamSweepLoop,
} from "./services/stream/stream.service";
import {
  onTranscript,
  startWorkerPool,
  stopWorkerPool,
} from "./services/audio/workers/pool";
import { transcriptToStreamMessage } from "./services/audio/result";
import { PROTOCOL_MAJOR } from "@mentra/cloud-protocol/envelope";
import {
  resolveRuntimeServices,
  serviceList,
  type RuntimeServiceName,
} from "./services/runtime-services";
import { getStreamProvider } from "./services/stream/stream.service";
import { assertAcsTeamsConfigured } from "./services/meetings/acs-teams.service";
import {
  assertManifestMatchesRuntimeServices,
  parseDeploymentManifest,
} from "./services/deployment-manifest";

const logger = createLogger("runtime");

type RuntimeEnv = Record<string, string | undefined>;

const DEPLOYED_RUNTIME_ENV_KEYS = [
  "PORTER_APP_NAME",
  "PORTER_SERVICE_NAME",
  "KUBERNETES_SERVICE_HOST",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "FLY_APP_NAME",
  "K_SERVICE",
  "RENDER",
  "HEROKU_APP_NAME",
] as const;

function isIPv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

function isIgnoredInterface(name: string): boolean {
  return /^(lo|awdl|llw|utun|tun|tap|bridge|docker|veth|vmnet|tailscale|zt)/i.test(
    name,
  );
}

function preferredInterfaceRank(name: string): number {
  if (/^(en|eth|wlan|wi-?fi)/i.test(name)) return 0;
  return 1;
}

export function detectLanIPv4(
  opts: {
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    preferredInterface?: string;
  } = {},
): string | undefined {
  const interfaces = opts.interfaces ?? os.networkInterfaces();
  const preferredInterface = opts.preferredInterface?.trim();
  const candidates: Array<{ name: string; address: string }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!name || !entries?.length) continue;
    if (preferredInterface && name !== preferredInterface) continue;
    if (!preferredInterface && isIgnoredInterface(name)) continue;
    for (const entry of entries) {
      if (
        !entry ||
        entry.internal ||
        !isIPv4Family(entry.family) ||
        !isPrivateIPv4(entry.address)
      )
        continue;
      candidates.push({ name, address: entry.address });
    }
  }

  candidates.sort(
    (a, b) => preferredInterfaceRank(a.name) - preferredInterfaceRank(b.name),
  );
  return candidates[0]?.address;
}

export function shouldAutoDetectUdpAdvertisedHost(
  env: RuntimeEnv = process.env,
): boolean {
  if (env.AUDIO_UDP_ADVERTISED_HOST?.trim()) return false;
  if (env.AUDIO_UDP_AUTO_DETECT_LAN === "false") return false;
  if (env.AUDIO_UDP_AUTO_DETECT_LAN === "true") return true;
  if (env.NODE_ENV === "production") return false;
  return !DEPLOYED_RUNTIME_ENV_KEYS.some((key) => !!env[key]);
}

export function resolveUdpAdvertisedHost(
  opts: {
    explicitHost?: string;
    env?: RuntimeEnv;
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  } = {},
): { host: string; source: "option" | "env" | "auto-lan" | "fallback" } {
  const env = opts.env ?? process.env;
  const explicitHost = opts.explicitHost?.trim();
  if (explicitHost) return { host: explicitHost, source: "option" };

  const envHost = env.AUDIO_UDP_ADVERTISED_HOST?.trim();
  if (envHost) return { host: envHost, source: "env" };

  if (shouldAutoDetectUdpAdvertisedHost(env)) {
    const host = detectLanIPv4({
      interfaces: opts.interfaces,
      preferredInterface:
        env.AUDIO_UDP_ADVERTISED_INTERFACE ?? env.AUDIO_UDP_INTERFACE,
    });
    if (host) return { host, source: "auto-lan" };
  }

  return { host: "127.0.0.1", source: "fallback" };
}

export interface StartRuntimeOptions {
  /** HTTP/WS port. Default: `process.env.PORT ?? 3001`. */
  httpPort?: number;
  /** UDP port. Default: `process.env.AUDIO_UDP_PORT ?? 8000`. */
  udpPort?: number;
  /** Redis URL. Default: env or `redis://127.0.0.1:6379`. */
  redisUrl?: string;
  /**
   * Host advertised in connection.ack's `audio.udp.host`. Default: env or
   * `127.0.0.1`. In prod this is the LB / NLB hostname clients should dial.
   */
  udpAdvertisedHost?: string;
  /**
   * Port advertised in connection.ack's `audio.udp.port`. Default: env or
   * matches `udpPort`. May differ from the bound port if the LB does
   * port translation.
   */
  udpAdvertisedPort?: number;
  /**
   * Number of audio workers to spawn. Default: env `AUDIO_WORKERS` or 2.
   * Each is a Bun Worker holding its own Redis streams connection,
   * processing audio for a slice of assigned users.
   */
  workerCount?: number;
  /**
   * Forward worker routing stubs over WS for low-level audio integration tests.
   * Real clients speak the public v2 protocol and should only receive
   * `stream.transcript` / `stream.translation`.
   */
  forwardTranscriptStubs?: boolean;
  /** Enabled HTTP/runtime modules. Defaults to RUNTIME_SERVICES or the legacy full profile. */
  services?: ReadonlySet<RuntimeServiceName>;
  /** Exact JSON served at /.well-known/mentra-deployment.json. */
  deploymentManifest?: string;
  /** Optional customer-owned HTML served by this Runtime for manifest legal links. */
  legalDocuments?: {
    privacy?: string;
    terms?: string;
  };
}

export interface RuntimeHandle {
  httpPort: number;
  udpPort: number;
  wsUrl: string;
  stop(): Promise<void>;
}

export async function startRuntime(
  opts: StartRuntimeOptions = {},
): Promise<RuntimeHandle> {
  assertRuntimeAuthConfigured();

  const services = new Set(opts.services ?? resolveRuntimeServices());
  const realtimeAudio = services.has("realtime-audio");
  if (services.has("managed-photos") && !realtimeAudio) {
    throw new Error("managed-photos currently requires realtime-audio");
  }
  const explicitServiceProfile =
    opts.services !== undefined ||
    Boolean(process.env.RUNTIME_SERVICES?.trim());
  if (explicitServiceProfile && services.has("managed-streams"))
    getStreamProvider();
  if (services.has("meetings")) assertAcsTeamsConfigured();
  const deploymentManifest =
    opts.deploymentManifest ?? (await loadDeploymentManifest());
  if (deploymentManifest) {
    assertManifestMatchesRuntimeServices(
      parseDeploymentManifest(deploymentManifest).manifest,
      services,
    );
  }
  const legalDocuments = opts.legalDocuments ?? (await loadLegalDocuments());
  if (services.has("meetings") && !deploymentManifest) {
    throw new Error("meetings service requires a deployment manifest");
  }

  const httpPort =
    opts.httpPort ?? Number.parseInt(process.env.PORT ?? "3001", 10);
  const udpPort =
    opts.udpPort ?? Number.parseInt(process.env.AUDIO_UDP_PORT ?? "8000", 10);
  const redisUrl =
    opts.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const resolvedUdpAdvertisedHost = resolveUdpAdvertisedHost({
    explicitHost: opts.udpAdvertisedHost,
  });
  const udpAdvertisedHost = resolvedUdpAdvertisedHost.host;
  const udpAdvertisedPort =
    opts.udpAdvertisedPort ??
    Number.parseInt(
      process.env.AUDIO_UDP_ADVERTISED_PORT ?? String(udpPort),
      10,
    );

  if (realtimeAudio) {
    configureAudioSession({ udpAdvertisedHost, udpAdvertisedPort });

    await connectRedis(redisUrl);
    await startUdpIngress(udpPort);

    // Single-sourced from ws.ts so the refresh loop, worker pool, and
    // upgrade-time ownership claims can never disagree on pod identity.
    const podId = getPodId();

    const workerCount =
      opts.workerCount ?? Number.parseInt(process.env.AUDIO_WORKERS ?? "2", 10);
    const forwardTranscriptStubs =
      opts.forwardTranscriptStubs ??
      (process.env.AUDIO_FORWARD_TRANSCRIPT_STUBS === "true" ||
        process.env.AUDIO_DEBUG_ECHO === "true");
    startWorkerPool({ podId, count: workerCount });
    // Route worker-emitted transcripts to the user's WS sessions on this pod.
    // Real transcripts become v2 `stream.transcript` / `stream.translation`
    // envelopes (see services/audio/result). Routing stubs (TRANSCRIPT_STUB) are
    // internal/debug signals; only forward them when explicitly requested by
    // low-level integration tests.
    onTranscript((msg) => {
      if (msg.type === "TRANSCRIPT_STUB") {
        if (forwardTranscriptStubs) {
          forwardToUserSessions(msg.mentraUserId, msg);
        }
        return;
      }
      if (msg.type === "UDP_LIVENESS_ACK") {
        logger.debug(
          {
            mentraUserId: msg.mentraUserId,
            sessionTag: msg.sessionTag,
            probeId: msg.probeId,
          },
          "udp liveness ack forwarding to owner websocket sessions",
        );
        forwardToUserSessions(msg.mentraUserId, {
          v: PROTOCOL_MAJOR,
          type: "audio.udp_liveness_ack",
          timestamp: Date.now(),
          payload: {
            sessionId: msg.audioSessionId,
            sessionTag: msg.sessionTag,
            probeId: msg.probeId,
            receivedAt: msg.receivedAt,
          },
        });
        return;
      }
      forwardToUserSessions(msg.mentraUserId, transcriptToStreamMessage(msg));
    });

    // Refresh-owned-claims loop: keeps each owned user's Redis claim alive
    // while this pod holds their WS. Idempotent in case startRuntime is called
    // twice in a test.
    startOwnershipRefreshLoop({
      podId,
      getOwnedUserIds,
      onLostOwnership: dropUserSessionsForLostOwnership,
    });
  }

  // Reclaim Cloudflare Stream inputs and recordings whose stream ended without
  // a stop() -- a disconnect, a closed app, a pod restart. Left alone these
  // accumulate until the account hits its storage quota, at which point
  // Cloudflare accepts new live inputs but rejects the broadcast at publish.
  // cameraApi's legacy durable registry is mounted with managed-photos. The
  // HTTP-only managed-streams module owns a separate in-process cleanup loop;
  // running both against the same Cloudflare account races stream deletion.
  if (realtimeAudio && services.has("managed-photos")) startStreamSweepLoop();

  // The REST surface (Hono): subscriptions today, health, camera later. The WS
  // upgrade is tried first; everything else falls through to this app.
  const apiHandle = createApiApp({
    readinessChecks: realtimeAudio ? [redisReadinessCheck] : [],
    services,
    deploymentManifest,
    legalDocuments,
  });

  const server = Bun.serve({
    port: httpPort,
    async fetch(req, srv) {
      if (realtimeAudio) {
        const wsResult = await tryWsUpgrade(req, srv);
        if (wsResult !== HTTP_FALLTHROUGH) return wsResult;
      }
      return apiHandle.app.fetch(req);
    },
    websocket: wsHandlers,
  });

  const boundHttpPort = server.port!;
  logger.info(
    {
      httpPort: boundHttpPort,
      udpPort,
      udpAdvertisedHost,
      udpAdvertisedPort,
      udpAdvertisedHostSource: resolvedUdpAdvertisedHost.source,
      services: serviceList(services),
    },
    "cloud-v2 runtime listening",
  );

  return {
    httpPort: boundHttpPort,
    udpPort,
    wsUrl: `ws://localhost:${boundHttpPort}/ws/session`,
    async stop() {
      if (realtimeAudio) {
        stopOwnershipRefreshLoop();
        stopStreamSweepLoop();
        await stopWorkerPool();
      }
      await apiHandle.stop();
      server.stop();
      if (realtimeAudio) {
        await stopUdpIngress();
        await disconnectRedis();
      }
    },
  };
}

async function loadDeploymentManifest(): Promise<string | undefined> {
  const inline = process.env.DEPLOYMENT_MANIFEST_JSON?.trim();
  const path = process.env.DEPLOYMENT_MANIFEST_PATH?.trim();
  if (inline && path)
    throw new Error(
      "set only one of DEPLOYMENT_MANIFEST_JSON or DEPLOYMENT_MANIFEST_PATH",
    );
  if (inline) return parseDeploymentManifest(inline).body;
  if (!path) return undefined;
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new Error(`DEPLOYMENT_MANIFEST_PATH does not exist: ${path}`);
  return parseDeploymentManifest(await file.text()).body;
}

async function loadLegalDocuments(): Promise<{
  privacy?: string;
  terms?: string;
}> {
  const [privacy, terms] = await Promise.all([
    loadOptionalDocument("DEPLOYMENT_PRIVACY_PATH"),
    loadOptionalDocument("DEPLOYMENT_TERMS_PATH"),
  ]);
  return { privacy, terms };
}

async function loadOptionalDocument(
  envName: string,
): Promise<string | undefined> {
  const path = process.env[envName]?.trim();
  if (!path) return undefined;
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new Error(`${envName} does not exist: ${path}`);
  if (file.size > 256 * 1024) throw new Error(`${envName} exceeds 256 KiB`);
  return file.text();
}

/** @deprecated Use StartRuntimeOptions. */
export type StartAudioOptions = StartRuntimeOptions;
/** @deprecated Use RuntimeHandle. */
export type AudioHandle = RuntimeHandle;
/** @deprecated Use startRuntime. */
export const startAudio = startRuntime;

if (import.meta.main) {
  const handle = await startRuntime();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown requested");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
