/**
 * @fileoverview Cloudflare Stream provider (real live-input provisioning).
 *
 * Provisions a Cloudflare Stream live input over the Cloudflare API and returns
 * its RTMPS ingest + HLS/DASH playback coordinates. No SDK: a couple of authed
 * fetch calls.
 *
 * Config (env):
 *   CF_STREAM_ACCOUNT_ID         Cloudflare account id
 *   CF_STREAM_API_TOKEN          API token with Stream:Edit
 *   CF_STREAM_CUSTOMER_SUBDOMAIN customer-<code>.cloudflarestream.com (for playback URLs)
 *
 * Cloudflare API:
 *   POST   /accounts/:acct/stream/live_inputs   -> { result: { uid, rtmps:{url,streamKey}, ... } }
 *   DELETE /accounts/:acct/stream/live_inputs/:uid
 */

import type { ManagedStream, StreamOptions } from "../../../protocol/camera";
import type { StreamProvider } from "../stream.service";

const CF_API = "https://api.cloudflare.com/client/v4";

interface LiveInputResult {
  result?: {
    uid: string;
    rtmps?: { url: string; streamKey: string };
    rtmpsPlayback?: { url: string; streamKey: string };
    srt?: { url: string; streamId: string; passphrase: string };
  };
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
}

/** First defined value among the given env var names. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

export function createCloudflareStreamProvider(): StreamProvider {
  // Accept the CF_STREAM_* names plus the v1 CLOUDFLARE_* names, so existing
  // Cloudflare credentials work without re-keying. The token needs Stream:Edit.
  const accountId = env("CF_STREAM_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = env("CF_STREAM_API_TOKEN", "CLOUDFLARE_API_TOKEN");
  const customerSubdomain = env("CF_STREAM_CUSTOMER_SUBDOMAIN");

  if (!accountId || !apiToken) {
    throw new Error(
      "STREAM_PROVIDER=cloudflare requires CF_STREAM_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID " +
        "and CF_STREAM_API_TOKEN/CLOUDFLARE_API_TOKEN.",
    );
  }

  const base = `${CF_API}/accounts/${accountId}/stream/live_inputs`;
  const authHeaders = { Authorization: `Bearer ${apiToken}` };

  /** Playback host for a live input. Falls back to Cloudflare's shared host. */
  function playbackUrls(uid: string): { hls: string; dash: string } {
    const host = customerSubdomain
      ? `https://${customerSubdomain}`
      : "https://videodelivery.net";
    return {
      hls: `${host}/${uid}/manifest/video.m3u8`,
      dash: `${host}/${uid}/manifest/video.mpd`,
    };
  }

  return {
    name: "cloudflare",

    async provision(mentraUserId: string, opts: StreamOptions): Promise<ManagedStream> {
      void opts;
      const res = await fetch(base, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: { name: `mentra-${mentraUserId}` },
          recording: { mode: "automatic" },
        }),
      });
      const body = (await res.json()) as LiveInputResult;
      if (!res.ok || !body.success || !body.result) {
        const detail = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
        throw new Error(`cloudflare live input create failed: ${detail}`);
      }
      const { uid, rtmps } = body.result;
      return {
        streamId: uid,
        ingest: {
          protocol: "rtmps",
          url: rtmps?.url ?? "",
          streamKey: rtmps?.streamKey ?? "",
        },
        playback: playbackUrls(uid),
      };
    },

    async stop(streamId: string): Promise<void> {
      const res = await fetch(`${base}/${streamId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare live input delete failed: ${res.status}`);
      }
    },
  };
}
