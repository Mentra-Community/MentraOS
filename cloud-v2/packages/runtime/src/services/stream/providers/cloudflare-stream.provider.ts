/**
 * @fileoverview Cloudflare Stream provider (real live-input provisioning).
 *
 * Provisions a Cloudflare Stream live input over the Cloudflare API and returns
 * its ingest (RTMPS + SRT + WebRTC/WHIP) and HLS/DASH playback coordinates.
 * No SDK: a couple of authed fetch calls.
 *
 * All three ingest protocols are surfaced because real networks differ: office
 * firewalls commonly kill RTMPS:443 mid-handshake while SRT passes, and the
 * device-side publisher picks its protocol from the URL prefix. The composed
 * `rtmpUrl`/`srtUrl`/`webrtcPublishUrl` are ready-to-publish (stream key /
 * streamid+passphrase already embedded).
 *
 * Config (env):
 *   CF_STREAM_ACCOUNT_ID         Cloudflare account id
 *   CF_STREAM_API_TOKEN          API token with Stream:Edit
 *   CF_STREAM_CUSTOMER_SUBDOMAIN customer-<code>.cloudflarestream.com (for playback URLs)
 *
 * Cloudflare API:
 *   POST   /accounts/:acct/stream/live_inputs        -> { result: { uid, rtmps, srt, webRTC, ... } }
 *   GET    /accounts/:acct/stream/live_inputs/:uid   -> { result: { status: { current: {...} } } }
 *   DELETE /accounts/:acct/stream/live_inputs/:uid
 *   POST   /accounts/:acct/stream/live_inputs/:uid/outputs   (restream destinations)
 */

import type { ManagedStream, StreamOptions, StreamStatusResult } from "@mentra/cloud-protocol/camera";
import type { StreamProvider } from "../stream.service";

const CF_API = "https://api.cloudflare.com/client/v4";

interface LiveInputResult {
  result?: {
    uid: string;
    rtmps?: { url: string; streamKey: string };
    rtmpsPlayback?: { url: string; streamKey: string };
    srt?: { url: string; streamId: string; passphrase: string };
    webRTC?: { url: string };
    webRTCPlayback?: { url: string };
    status?: {
      current?: {
        state?: string | null;
        statusEnteredAt?: string;
        statusLastSeen?: string;
        reason?: string;
      } | null;
    } | null;
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
      const res = await fetch(base, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: { name: `mentra-${mentraUserId}` },
          // Cloudflare only serves live HLS/DASH manifests when recording is
          // on (there's no "relay only, keep nothing" mode) — see provider
          // header comment. We don't use the saved VOD after the call, so
          // auto-delete it as soon as Cloudflare allows instead of letting it
          // eat the account's storage quota (which caused ingest to be refused
          // at `publish` once the account went over its cap). Cloudflare's
          // minimum for deleteRecordingAfterDays is 30 (valid range 30-1096);
          // anything lower fails live-input validation.
          recording: { mode: "automatic", deleteRecordingAfterDays: 30 },
        }),
      });
      const body = (await res.json()) as LiveInputResult;
      if (!res.ok || !body.success || !body.result) {
        const detail = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
        throw new Error(`cloudflare live input create failed: ${detail}`);
      }
      const { uid, rtmps, srt, webRTC, webRTCPlayback } = body.result;

      // Ready-to-publish URLs: key/credentials embedded so the device can use
      // them verbatim (its publisher detects protocol from the URL prefix).
      const rtmpUrl = rtmps?.url && rtmps?.streamKey ? `${rtmps.url}${rtmps.streamKey}` : undefined;
      const srtUrl =
        srt?.url && srt?.streamId && srt?.passphrase
          ? `${srt.url}?streamid=${encodeURIComponent(srt.streamId)}&passphrase=${encodeURIComponent(srt.passphrase)}`
          : undefined;

      // Restream destinations (re-publish the ingest to external RTMP targets).
      // Best-effort: a failed output should not fail the provision — the stream
      // itself is healthy without it.
      const destinations = opts.restreamDestinations ?? [];
      for (const dest of destinations) {
        const url = typeof dest === "string" ? dest : dest.url;
        const name = typeof dest === "string" ? undefined : dest.name;
        try {
          await fetch(`${base}/${uid}/outputs`, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ url, enabled: true, ...(name ? { meta: { name } } : {}) }),
          });
        } catch {
          /* best-effort; surfaced via status polling if it matters */
        }
      }

      return {
        streamId: uid,
        ingest: {
          protocol: "rtmps",
          url: rtmps?.url ?? "",
          streamKey: rtmps?.streamKey ?? "",
          rtmpUrl,
          srtUrl,
          webrtcPublishUrl: webRTC?.url,
        },
        playback: {
          ...playbackUrls(uid),
          webrtc: webRTCPlayback?.url,
        },
      };
    },

    async status(streamId: string): Promise<StreamStatusResult> {
      const res = await fetch(`${base}/${streamId}`, { headers: authHeaders });
      const body = (await res.json()) as LiveInputResult;
      if (!res.ok || !body.success || !body.result) {
        const detail = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
        throw new Error(`cloudflare live input status failed: ${detail}`);
      }
      const current = body.result.status?.current ?? null;
      const state = current?.state ?? null;
      return {
        streamId,
        isConnected: state === "connected",
        state,
        connectedAt: current?.statusEnteredAt,
        lastSeenAt: current?.statusLastSeen,
        reason: current?.reason,
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
