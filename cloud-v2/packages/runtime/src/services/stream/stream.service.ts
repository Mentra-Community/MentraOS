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
import { createCloudflareStreamProvider } from "./providers/cloudflare-stream.provider";

const logger = createLogger("audio").child({ service: "stream.service" });

export interface StreamProvider {
  readonly name: string;
  provision(mentraUserId: string, opts: StreamOptions): Promise<ManagedStream>;
  status(streamId: string): Promise<StreamStatusResult>;
  stop(streamId: string): Promise<void>;
  /**
   * Delete the finished recordings belonging to a stream, returning how many
   * went. `stop()` already does this; it is exposed so the sweeper can reclaim
   * recordings whose stream ended without anyone calling `stop()`.
   *
   * Optional: a provider that does not record has nothing to delete.
   */
  deleteRecordings?(streamId: string): Promise<number>;
  /**
   * Delete recordings and inputs abandoned before `olderThanMs`, returning what
   * was reclaimed. Optional for the same reason.
   */
  sweep?(olderThanMs: number): Promise<{ recordings: number; inputs: number }>;
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

// === Recording sweep loop ===

/** How often to sweep. Cheap: one list call plus deletes for what it finds. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How stale an input must be before the sweeper reclaims it. Comfortably longer
 * than any real session, so a long-running stream is never cut short.
 */
const SWEEP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

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
  if (sweepTimer) return;

  const run = async () => {
    try {
      const p = getStreamProvider();
      if (!p.sweep) return;
      const { recordings, inputs } = await p.sweep(SWEEP_MIN_AGE_MS);
      if (recordings || inputs) {
        logger.info({ recordings, inputs }, "stream sweep reclaimed abandoned inputs");
      }
    } catch (err) {
      // A provider that is not configured, or a Cloudflare blip. Next tick retries.
      logger.warn({ err }, "stream sweep failed");
    }
  };

  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  void run();
}

/** Test/shutdown hook: stop the sweep loop. */
export function stopStreamSweepLoop(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
