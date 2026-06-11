/**
 * @fileoverview Redis client lifecycle for cloud-audio.
 *
 * Two clients up front:
 *
 *   `redis`        — the main ioredis client. Used for ownership-claim writes
 *                    (SET with TTL + refresh), XADD ingress writes, XACK,
 *                    XAUTOCLAIM, transient KV.
 *
 *   `redisStreams` — a dedicated client for blocking XREADGROUP calls in the
 *                    dispatch loop. ioredis serializes commands on a single
 *                    connection; if a blocking read sits on the main client,
 *                    every other command queues behind it. A second client
 *                    sidesteps that.
 *
 * Both clients share the same `REDIS_URL`. Readiness considers Redis healthy
 * iff the main client is in `ready` state.
 */

import { Redis } from "ioredis";
import { createLogger, type ReadinessCheck } from "@mentra/cloud-shared";

const logger = createLogger("audio").child({ component: "redis" });

let mainClient: Redis | null = null;
let streamsClient: Redis | null = null;
let connectPromise: Promise<void> | null = null;

/**
 * Open Redis connections. Idempotent: calling twice with the same URL is a
 * no-op. Throws on initial connection failure; ioredis auto-reconnects with
 * backoff thereafter.
 */
export async function connectRedis(url: string): Promise<void> {
  if (mainClient?.status === "ready" && streamsClient?.status === "ready") {
    logger.warn("connectRedis called while already connected; ignoring");
    return;
  }

  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    await closeClients();

    const nextMain = buildClient(url, "main");
    const nextStreams = buildClient(url, "streams");
    mainClient = nextMain;
    streamsClient = nextStreams;

    try {
      // Wait for both to report ready before returning. Either failing here
      // surfaces the misconfiguration at boot rather than at first command.
      await Promise.all([waitReady(nextMain), waitReady(nextStreams)]);
    } catch (err) {
      await closeClients(nextMain, nextStreams);
      if (mainClient === nextMain) mainClient = null;
      if (streamsClient === nextStreams) streamsClient = null;
      throw err;
    }
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

function buildClient(url: string, label: string): Redis {
  const client = new Redis(url, {
    // Don't queue commands while disconnected — surface errors to callers
    // immediately rather than silently buffering audio for a dead Redis.
    enableOfflineQueue: false,
    // Default lazyConnect=false means we connect on construction; combined
    // with the awaited `ready` event below, boot fails fast on bad config.
    maxRetriesPerRequest: 3,
  });

  client.on("connect", () => logger.info({ label }, "redis connecting"));
  client.on("ready", () => logger.info({ label }, "redis ready"));
  client.on("error", (err) => logger.error({ label, err }, "redis error"));
  client.on("close", () => logger.warn({ label }, "redis closed"));
  client.on("reconnecting", (ms: number) =>
    logger.warn({ label, retryInMs: ms }, "redis reconnecting"),
  );

  return client;
}

function waitReady(client: Redis): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      client.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      client.off("ready", onReady);
      reject(err);
    };
    client.once("ready", onReady);
    client.once("error", onError);
  });
}

/** Main client. Use for non-blocking commands. */
export function getRedis(): Redis {
  if (!mainClient) throw new Error("redis not connected — call connectRedis() first");
  return mainClient;
}

/** Streams client. Use for blocking XREADGROUP / XAUTOCLAIM. */
export function getRedisStreams(): Redis {
  if (!streamsClient) throw new Error("redis not connected — call connectRedis() first");
  return streamsClient;
}

/** Close both clients. Call from graceful-shutdown handlers. */
export async function disconnectRedis(): Promise<void> {
  await closeClients();
  mainClient = null;
  streamsClient = null;
}

async function closeClients(
  main: Redis | null = mainClient,
  streams: Redis | null = streamsClient,
): Promise<void> {
  await Promise.all([
    main?.quit().catch(() => undefined),
    streams?.quit().catch(() => undefined),
  ]);
}

/**
 * Readiness check for `/ready`. Considers Redis healthy iff the main client
 * is in `ready` state. The streams client riding on the same URL is
 * presumed-OK if the main one is — they share network conditions.
 */
export const redisReadinessCheck: ReadinessCheck = {
  name: "redis",
  check: () => mainClient?.status === "ready",
};
