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
 * When imported, nothing runs — call `startAudio(...)`. When executed
 * directly, the bottom block drives boot from env vars.
 *
 * Spec + design: cloud-v2/docs/issues/003-audio/.
 */

import { createHealthApp, createLogger } from "@mentra/cloud-shared";
import {
  connectRedis,
  disconnectRedis,
  redisReadinessCheck,
} from "./clients/redis.client";
import os from "node:os";
import {
  configureAudioSession,
  forwardToUserSessions,
  getOwnedUserIds,
  HTTP_FALLTHROUGH,
  tryWsUpgrade,
  wsHandlers,
} from "./net/ws";
import {
  startUdpIngress,
  stopUdpIngress,
} from "./net/udp";
import {
  startOwnershipRefreshLoop,
  stopOwnershipRefreshLoop,
} from "./services/session/ownership";
import {
  onTranscript,
  startWorkerPool,
  stopWorkerPool,
} from "./services/audio/workers/pool";
import { transcriptToDataStream } from "./wire/phone-protocol";

const logger = createLogger("audio");

export interface StartAudioOptions {
  /** HTTP/WS port. Default: `process.env.PORT ?? 3001`. */
  httpPort?: number;
  /** UDP port. Default: `process.env.AUDIO_UDP_PORT ?? 8000`. */
  udpPort?: number;
  /** Redis URL. Default: env or `redis://127.0.0.1:6379`. */
  redisUrl?: string;
  /**
   * Host advertised in CONNECTION_ACK's `udp.host`. Default: env or
   * `127.0.0.1`. In prod this is the LB / NLB hostname clients should dial.
   */
  udpAdvertisedHost?: string;
  /**
   * Port advertised in CONNECTION_ACK's `udp.port`. Default: env or
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
}

export interface AudioHandle {
  httpPort: number;
  udpPort: number;
  wsUrl: string;
  stop(): Promise<void>;
}

export async function startAudio(opts: StartAudioOptions = {}): Promise<AudioHandle> {
  const httpPort = opts.httpPort ?? Number.parseInt(process.env.PORT ?? "3001", 10);
  const udpPort =
    opts.udpPort ?? Number.parseInt(process.env.AUDIO_UDP_PORT ?? "8000", 10);
  const redisUrl =
    opts.redisUrl ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const udpAdvertisedHost =
    opts.udpAdvertisedHost ?? process.env.AUDIO_UDP_ADVERTISED_HOST ?? "127.0.0.1";
  const udpAdvertisedPort =
    opts.udpAdvertisedPort ??
    Number.parseInt(process.env.AUDIO_UDP_ADVERTISED_PORT ?? String(udpPort), 10);

  configureAudioSession({ udpAdvertisedHost, udpAdvertisedPort });

  await connectRedis(redisUrl);
  await startUdpIngress(udpPort);

  const podId = process.env.POD_ID ?? process.env.HOSTNAME ?? os.hostname();

  const workerCount =
    opts.workerCount ??
    Number.parseInt(process.env.AUDIO_WORKERS ?? "2", 10);
  startWorkerPool({ podId, count: workerCount });
  // Route worker-emitted transcripts to the user's WS sessions on this pod.
  // Real transcripts are translated into the v1 `data_stream` envelope the
  // mobile expects (see wire/phone-protocol). Debug stubs (TRANSCRIPT_STUB)
  // pass through untouched — only the test client reads them; the mobile
  // ignores unknown message types.
  onTranscript((msg) => {
    const out =
      msg.type === "TRANSCRIPT" ? transcriptToDataStream(msg) : msg;
    forwardToUserSessions(msg.mentraUserId, out);
  });

  // Refresh-owned-claims loop: keeps each owned user's Redis claim alive
  // while this pod holds their WS. Idempotent in case startAudio is called
  // twice in a test.
  startOwnershipRefreshLoop({ podId, getOwnedUserIds });

  const healthApp = createHealthApp({
    packageName: "audio",
    readinessChecks: [redisReadinessCheck],
  });

  const server = Bun.serve({
    port: httpPort,
    async fetch(req, srv) {
      const wsResult = await tryWsUpgrade(req, srv);
      if (wsResult !== HTTP_FALLTHROUGH) return wsResult;
      return healthApp.fetch(req);
    },
    websocket: wsHandlers,
  });

  const boundHttpPort = server.port!;
  logger.info(
    { httpPort: boundHttpPort, udpPort },
    "cloud-v2 audio listening (UDP + WS ready; workers + streams pending)",
  );

  return {
    httpPort: boundHttpPort,
    udpPort,
    wsUrl: `ws://localhost:${boundHttpPort}/ws/session`,
    async stop() {
      stopOwnershipRefreshLoop();
      await stopWorkerPool();
      server.stop();
      await stopUdpIngress();
      await disconnectRedis();
    },
  };
}

if (import.meta.main) {
  const handle = await startAudio();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown requested");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
