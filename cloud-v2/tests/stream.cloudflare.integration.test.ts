/**
 * @fileoverview Real Cloudflare Stream provisioning (no mocks).
 *
 * Provisions a real live input on Cloudflare Stream, asserts it comes back with
 * RTMPS ingest + HLS/DASH playback coordinates, then deletes it (cleanup).
 *
 * Gated on Cloudflare creds (CF_STREAM_* or the v1 CLOUDFLARE_ACCOUNT_ID +
 * CLOUDFLARE_API_TOKEN). The token must have Stream:Edit. The cloud-v2 Doppler
 * config has them, so:
 *   doppler run --project cloud-v2 --config dev -- bun test tests/stream.cloudflare.integration.test.ts
 * Without creds the suite skips.
 */

import { describe, expect, test } from "bun:test";
import { createCloudflareStreamProvider } from "../packages/runtime/src/services/stream/providers/cloudflare-stream.provider";

const RUN = !!(
  (process.env.CF_STREAM_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) &&
  (process.env.CF_STREAM_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN)
);

if (!RUN) {
  console.log(
    "[stream.cloudflare] skipped (no Cloudflare creds). Run with: doppler run --project cloud-v2 --config dev -- bun test tests/stream.cloudflare.integration.test.ts",
  );
}

describe.skipIf(!RUN)("Cloudflare Stream (real provisioning)", () => {
  test("provision a live input -> ingest + playback -> stop", async () => {
    const provider = createCloudflareStreamProvider();

    const stream = await provider.provision("test-user", {});
    try {
      expect(stream.streamId.length).toBeGreaterThan(0);
      // RTMPS ingest with a stream key.
      expect(typeof (stream.ingest as { url?: string }).url).toBe("string");
      expect((stream.ingest as { url?: string }).url).toContain("rtmps");
      expect(typeof (stream.ingest as { streamKey?: string }).streamKey).toBe("string");
      // HLS playback manifest for the live input id.
      const hls = (stream.playback as { hls?: string }).hls ?? "";
      expect(hls).toContain(stream.streamId);
      expect(hls).toContain(".m3u8");
    } finally {
      // Always tear down the live input we created.
      await provider.stop(stream.streamId);
    }
  }, 30_000);
});
