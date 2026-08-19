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
 *   GET    /accounts/:acct/stream/live_inputs/:uid/videos     (recordings of this input)
 *   DELETE /accounts/:acct/stream/:videoUid                   (a recording)
 *
 * Recordings are separate objects from the live input and outlive it: deleting
 * an input orphans its recordings, which keep counting against the account's
 * storage quota. Recording cannot simply be turned off -- HLS playback requires
 * `mode: automatic` -- so `stop()` deletes the recordings before the input, and
 * `deleteRecordingAfterDays` is set as a floor for anything that slips past.
 */

import type { ManagedStream, StreamOptions, StreamStatusResult } from "@mentra/cloud-protocol/camera";
import type { StreamProvider } from "../stream.service";

const CF_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's minimum for `deleteRecordingAfterDays`. A floor, not the policy. */
const RECORDING_RETENTION_DAYS = 30;

/** `GET /live_inputs` -- every input on the account. */
interface LiveInputListResult {
  result?: Array<{
    uid: string;
    created?: string;
    modified?: string;
    status?: { current?: { state?: string | null } | null } | null;
  }>;
  success: boolean;
}

/** `GET /live_inputs/:uid/videos` -- the recordings produced by an input. */
interface VideoListResult {
  result?: Array<{
    uid: string;
    status?: { state?: string } | null;
  }>;
  success: boolean;
}

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

  /**
   * Delete every finished recording belonging to a live input.
   *
   * Best-effort by design: a stream that has just ended may not have a
   * recording yet (Cloudflare takes up to ~60s to make one available), and a
   * failure here must not stop the caller from tearing the input down. What
   * this misses, the sweeper and `deleteRecordingAfterDays` catch.
   *
   * Returns the number deleted, so callers can log it.
   */
  async function deleteRecordings(inputUid: string): Promise<number> {
    const listed = await fetch(`${base}/${inputUid}/videos`, { headers: authHeaders });
    if (!listed.ok) return 0;

    const body = (await listed.json()) as VideoListResult;
    const videos = body.result ?? [];
    let deleted = 0;

    for (const video of videos) {
      // An in-progress broadcast is not a recording yet. Deleting it would
      // kill a live stream.
      if (video.status?.state === "live-inprogress") continue;

      const res = await fetch(`${CF_API}/accounts/${accountId}/stream/${video.uid}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (res.ok || res.status === 404) deleted += 1;
    }
    return deleted;
  }

  /**
   * Reclaim what `stop()` never got to.
   *
   * `stop()` only runs when a client explicitly ends a stream. A stream that
   * ends because the device dropped, the app closed, or the pod restarted
   * leaves its input and recordings behind forever. That is the leak that
   * filled the account: thousands of abandoned inputs, each with recordings
   * still billed against the storage quota.
   *
   * Deletes inputs (and their recordings) last modified before the cutoff,
   * skipping anything currently connected. Idempotent: a 404 counts as done,
   * so concurrent pods sweeping at once is harmless.
   */
  async function sweep(olderThanMs: number): Promise<{ recordings: number; inputs: number }> {
    const cutoff = Date.now() - olderThanMs;
    let recordings = 0;
    let inputs = 0;

    const listed = await fetch(base, { headers: authHeaders });
    if (!listed.ok) return { recordings, inputs };

    const body = (await listed.json()) as LiveInputListResult;
    for (const input of body.result ?? []) {
      const modified = Date.parse(input.modified ?? input.created ?? "");
      if (!Number.isFinite(modified) || modified >= cutoff) continue;

      // Never touch an input a device is publishing to right now.
      const state = input.status?.current?.state ?? null;
      if (state === "connected" || state === "live") continue;

      recordings += await deleteRecordings(input.uid);

      const res = await fetch(`${base}/${input.uid}`, { method: "DELETE", headers: authHeaders });
      if (res.ok || res.status === 404) inputs += 1;
    }
    return { recordings, inputs };
  }

  return {
    name: "cloudflare",

    async provision(mentraUserId: string, opts: StreamOptions): Promise<ManagedStream> {
      const res = await fetch(base, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: { name: `mentra-${mentraUserId}` },
          // `automatic` is required: HLS/DASH playback does not work with
          // recording off, and Mentra Call needs the live HLS URL.
          recording: { mode: "automatic" },
          // Backstop only. `stop()` deletes recordings explicitly; this bounds
          // anything it misses (a stream that ends by disconnect, a failed
          // delete). Cloudflare's minimum for this field is 30 days, so it
          // cannot replace explicit deletion.
          deleteRecordingAfterDays: RECORDING_RETENTION_DAYS,
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
      // Recordings first, then the input. Deleting the input orphans its
      // recordings -- they survive, keep counting against the storage quota,
      // and are no longer reachable through the input's /videos listing -- so
      // the order matters. Once the account is over quota Cloudflare still
      // creates live inputs but rejects the broadcast at publish, which
      // surfaces to the user as a network failure.
      await deleteRecordings(streamId);

      const res = await fetch(`${base}/${streamId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`cloudflare live input delete failed: ${res.status}`);
      }
    },

    deleteRecordings,
    sweep,
  };
}
