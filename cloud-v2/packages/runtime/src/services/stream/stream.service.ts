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
import { createCloudflareStreamProvider } from "./providers/cloudflare-stream.provider";

export interface StreamProvider {
  readonly name: string;
  provision(mentraUserId: string, opts: StreamOptions): Promise<ManagedStream>;
  status(streamId: string): Promise<StreamStatusResult>;
  stop(streamId: string): Promise<void>;
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
