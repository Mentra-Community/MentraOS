/**
 * @fileoverview Live-stream provisioning abstraction for managed stream.
 *
 * Managed stream provisions a real live video stream on a provider and returns
 * the ingest (where the device pushes) and playback (where viewers watch)
 * coordinates. Unlike blob storage there is no local-real equivalent (you can't
 * stand up a real RTMP ingest + HLS playback with no dependency), so the only
 * provider today is Cloudflare Stream. With no provider configured, provisioning
 * fails loudly rather than returning fake coordinates.
 *
 * Provider is chosen by `STREAM_PROVIDER` (default "cloudflare").
 *
 * Spec: docs/issues/002-cloud-runtime/camera/spec.md ("Managed stream").
 */

import type { ManagedStream, StreamOptions, StreamStatusResult } from "@mentra/cloud-protocol/camera";
import { createLogger } from "@mentra/cloud-shared";
import { getRedis } from "../../clients/redis.client";
import { createCloudflareStreamProvider } from "./providers/cloudflare-stream.provider";

const logger = createLogger("audio").child({ service: "stream.service" });

export interface StreamProvider {
  readonly name: string;
  provision(mentraUserId: string, opts: StreamOptions): Promise<ManagedStream>;
  status(streamId: string): Promise<StreamStatusResult>;
  stop(streamId: string): Promise<StreamCleanupResult>;
  /**
   * Reclaim a known abandoned input. Unlike an explicit stop, an empty
   * recording list is terminal because the queue's grace period has elapsed.
   */
  reclaim?(streamId: string): Promise<StreamCleanupResult>;
  /** Seed the durable queue with inputs created before the queue existed. */
  discover?(): Promise<StreamDiscoveryResult>;
}

export interface StreamCleanupResult {
  recordings: number;
  input: "deleted" | "retained" | "missing";
}

export interface StreamDiscoveryResult {
  inputs: Array<{ streamId: string; createdAt: number }>;
  truncated: boolean;
}

let provider: StreamProvider | null = null;

/** The configured stream provider, or throws if none is configured. */
export function getStreamProvider(): StreamProvider {
  if (provider) return provider;
  const kind = process.env.STREAM_PROVIDER ?? "cloudflare";
  if (kind === "cloudflare") {
    provider = createCloudflareStreamProvider();
    return provider;
  }
  throw new Error(`unknown STREAM_PROVIDER: ${kind}`);
}

/** Test/boot hook: reset the cached provider. */
export function resetStreamProvider(): void {
  provider = null;
}

// === Managed stream lifecycle ===

const CLEANUP_QUEUE_KEY = "managed-stream:cleanup";
const ABANDONED_STREAM_GRACE_MS = 6 * 60 * 60 * 1000;
const STOP_CLEANUP_RETRY_MS = 60 * 1000;
const SWEEP_RETRY_MS = 15 * 60 * 1000;
const LEGACY_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

type CleanupAction = "reclaim" | "stop";

function cleanupQueueMember(action: CleanupAction, streamId: string): string {
  return `${action}:${streamId}`;
}

function parseCleanupQueueMember(member: string): {
  action: CleanupAction;
  streamId: string;
} {
  if (member.startsWith("stop:")) {
    return { action: "stop", streamId: member.slice("stop:".length) };
  }
  if (member.startsWith("reclaim:")) {
    return { action: "reclaim", streamId: member.slice("reclaim:".length) };
  }
  // Entries written by earlier builds used the bare stream id.
  return { action: "reclaim", streamId: member };
}

function cleanupQueueMembers(streamId: string): [string, string] {
  return [cleanupQueueMember("reclaim", streamId), cleanupQueueMember("stop", streamId)];
}

export async function provisionStream(
  mentraUserId: string,
  opts: StreamOptions,
): Promise<ManagedStream> {
  const p = getStreamProvider();
  const stream = await p.provision(mentraUserId, opts);
  try {
    await getRedis().zadd(
      CLEANUP_QUEUE_KEY,
      Date.now() + ABANDONED_STREAM_GRACE_MS,
      cleanupQueueMember("reclaim", stream.streamId),
    );
  } catch (err) {
    // Do not hand out an input that recovery cannot find. This input has never
    // been published to, so reclaiming an empty input is safe.
    await p.reclaim?.(stream.streamId).catch(() => undefined);
    throw err;
  }
  return stream;
}

export async function streamStatus(streamId: string): Promise<StreamStatusResult> {
  const status = await getStreamProvider().status(streamId);
  // Status is polled throughout an active managed stream. Treat each successful
  // observation as activity so a long-running stream never becomes sweepable
  // merely because its original provision time is old. XX prevents a status
  // response that finishes after completed teardown from recreating the entry.
  await getRedis()
    .zadd(
      CLEANUP_QUEUE_KEY,
      "XX",
      Date.now() + ABANDONED_STREAM_GRACE_MS,
      cleanupQueueMember("reclaim", streamId),
    )
    .catch((err) => logger.warn({ err, streamId }, "stream activity refresh failed"));
  return status;
}

export async function stopStream(streamId: string): Promise<void> {
  const redis = getRedis();
  const stopMember = cleanupQueueMember("stop", streamId);

  // Persist the finalization retry before touching Cloudflare. It is separate
  // from the inactivity deadline, so an in-flight status poll cannot postpone
  // an explicit stop and an empty recording list remains protected until a
  // later stop retry observes the finalized recording.
  await redis.zadd(CLEANUP_QUEUE_KEY, Date.now() + STOP_CLEANUP_RETRY_MS, stopMember);

  const result = await getStreamProvider().stop(streamId);
  if (result.input !== "retained") {
    await redis.zrem(CLEANUP_QUEUE_KEY, ...cleanupQueueMembers(streamId));
  }
}

// === Recording sweep loop ===

/** How often to process the durable cleanup queue. */
const SWEEP_INTERVAL_MS = STOP_CLEANUP_RETRY_MS;

let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepLoopStarted = false;
let nextLegacyDiscoveryAt = 0;

export async function sweepStreamsOnce(): Promise<{ recordings: number; inputs: number }> {
  const p = getStreamProvider();
  const redis = getRedis();
  const now = Date.now();

  // Best-effort migration for inputs created before the durable registry.
  // Cloudflare's endpoint exposes only its first window, so the registry is
  // authoritative for all newly provisioned streams. Queue processing runs
  // every minute, but account-wide discovery remains hourly.
  let discovered: StreamDiscoveryResult | undefined;
  if (now >= nextLegacyDiscoveryAt) {
    nextLegacyDiscoveryAt = now + LEGACY_DISCOVERY_INTERVAL_MS;
    try {
      discovered = await p.discover?.();
    } catch (err) {
      // Migration is advisory. A list-endpoint failure must never block cleanup
      // of inputs already present in the authoritative queue.
      logger.warn({ err }, "Cloudflare legacy input discovery failed");
    }
  }
  if (discovered) {
    const pipeline = redis.pipeline();
    for (const input of discovered.inputs) {
      pipeline.zadd(
        CLEANUP_QUEUE_KEY,
        "NX",
        input.createdAt + ABANDONED_STREAM_GRACE_MS,
        cleanupQueueMember("reclaim", input.streamId),
      );
    }
    await pipeline.exec();
    if (discovered.truncated) {
      logger.warn(
        { discovered: discovered.inputs.length },
        "Cloudflare legacy input discovery is truncated; durable registry remains authoritative",
      );
    }
  }

  const claimed = await redis.zrangebyscore(
    CLEANUP_QUEUE_KEY,
    "-inf",
    now,
    "LIMIT",
    0,
    SWEEP_BATCH_SIZE,
  );
  if (claimed.length > 0) {
    // Move the batch forward before touching Cloudflare. Concurrent pods may
    // very occasionally select the same batch, but provider operations are
    // idempotent and this avoids losing work if a pod exits mid-cleanup.
    const pipeline = redis.pipeline();
    for (const member of claimed) {
      const { action } = parseCleanupQueueMember(member);
      const retryMs = action === "stop" ? STOP_CLEANUP_RETRY_MS : SWEEP_RETRY_MS;
      pipeline.zadd(CLEANUP_QUEUE_KEY, now + retryMs, member);
    }
    await pipeline.exec();
  }

  let recordings = 0;
  let inputs = 0;
  for (const member of claimed) {
    const { action, streamId } = parseCleanupQueueMember(member);
    try {
      if (action === "reclaim" && !p.reclaim) continue;
      const result = action === "stop" ? await p.stop(streamId) : await p.reclaim!(streamId);
      recordings += result.recordings;
      if (result.input === "deleted" || result.input === "missing") {
        await redis.zrem(CLEANUP_QUEUE_KEY, ...cleanupQueueMembers(streamId), streamId);
        if (result.input === "deleted") inputs += 1;
      }
      // Retained inputs already carry the claim's retry timestamp.
    } catch (err) {
      logger.warn({ err, streamId }, "stream cleanup retained input for retry");
    }
  }
  return { recordings, inputs };
}

/**
 * Start the background sweep that reclaims abandoned live inputs and their
 * recordings.
 *
 * `stop()` handles the tidy case, but it only runs when a client explicitly
 * ends a stream; anything that ends by disconnect leaks. Recordings cannot be
 * disabled (HLS playback needs `mode: automatic`), and Cloudflare's built-in
 * `deleteRecordingAfterDays` has a 30-day minimum, so without this the account
 * fills and Cloudflare starts rejecting broadcasts at publish -- which reaches
 * the user as an unexplained network failure.
 *
 * Call once at startup. Idempotent, so a second call cannot create a duplicate
 * timer. Every pod running this is fine: deletes are idempotent and a 404
 * counts as success.
 */
export function startStreamSweepLoop(): void {
  if (sweepLoopStarted) return;
  sweepLoopStarted = true;

  const run = async () => {
    try {
      const { recordings, inputs } = await sweepStreamsOnce();
      if (recordings || inputs) {
        logger.info({ recordings, inputs }, "stream sweep reclaimed abandoned inputs");
      }
    } catch (err) {
      // A provider that is not configured, or a Cloudflare blip. Next tick retries.
      logger.warn({ err }, "stream sweep failed");
    } finally {
      // Schedule only after this run settles so slow account cleanup can never
      // overlap itself and multiply Cloudflare API traffic.
      if (sweepLoopStarted) sweepTimer = setTimeout(run, SWEEP_INTERVAL_MS);
    }
  };

  void run();
}

/** Test/shutdown hook: stop the sweep loop. */
export function stopStreamSweepLoop(): void {
  sweepLoopStarted = false;
  nextLegacyDiscoveryAt = 0;
  if (!sweepTimer) return;
  clearTimeout(sweepTimer);
  sweepTimer = null;
}
