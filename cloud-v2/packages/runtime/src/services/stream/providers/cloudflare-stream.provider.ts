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
 * Inputs are disabled before cleanup and retained whenever a recording is still
 * finalizing, so no billable recording becomes unreachable through its input.
 */

import type { ManagedStream, StreamOptions, StreamStatusResult } from "@mentra/cloud-protocol/camera";
import type {
  StreamCleanupResult,
  StreamDiscoveryResult,
  StreamProvider,
} from "../stream.service";

const CF_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's minimum for `deleteRecordingAfterDays`. A floor, not the policy. */
const RECORDING_RETENTION_DAYS = 30;

interface LiveInputSummary {
  uid?: string;
  created?: string;
  modified?: string;
  meta?: unknown;
}

/** `GET /live_inputs` -- every input on the account. */
interface LiveInputListResult {
  result?: {
    liveInputs?: LiveInputSummary[];
    range?: number;
    total?: number;
  };
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
    enabled?: boolean;
    meta?: unknown;
    rtmps?: { url: string; streamKey: string };
    rtmpsPlayback?: { url: string; streamKey: string };
    srt?: { url: string; streamId: string; passphrase: string };
    webRTC?: { url: string };
    webRTCPlayback?: { url: string };
    status?:
      | string
      | {
          current?: {
            state?: string | null;
            statusEnteredAt?: string;
            statusLastSeen?: string;
            reason?: string;
          } | null;
        }
      | null;
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

  function currentStatus(input: NonNullable<LiveInputResult["result"]>): {
    state: string | null;
    statusEnteredAt?: string;
    statusLastSeen?: string;
    reason?: string;
  } {
    if (typeof input.status === "string") return { state: input.status };
    return {
      state: input.status?.current?.state ?? null,
      statusEnteredAt: input.status?.current?.statusEnteredAt,
      statusLastSeen: input.status?.current?.statusLastSeen,
      reason: input.status?.current?.reason,
    };
  }

  function isReclaimProtectedState(state: string | null): boolean {
    return (
      state === "connected" ||
      state === "reconnected" ||
      state === "reconnecting" ||
      state === "live"
    );
  }

  function isConnectedState(state: string | null): boolean {
    return state === "connected" || state === "reconnected" || state === "live";
  }

  function isMentraInput(input: LiveInputSummary): boolean {
    if (!input.meta || typeof input.meta !== "object") return false;
    const name = (input.meta as Record<string, unknown>).name;
    return typeof name === "string" && name.startsWith("mentra-");
  }

  async function getLiveInput(inputUid: string): Promise<NonNullable<LiveInputResult["result"]> | null> {
    const res = await fetch(`${base}/${inputUid}`, { headers: authHeaders });
    if (res.status === 404) return null;

    const body = (await res.json()) as LiveInputResult;
    if (!res.ok || !body.success || !body.result) {
      const detail = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
      throw new Error(`cloudflare live input get failed: ${detail}`);
    }
    return body.result;
  }

  async function disableInput(inputUid: string): Promise<boolean> {
    const res = await fetch(`${base}/${inputUid}`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`cloudflare live input disable failed: ${res.status}`);
    return true;
  }

  async function deleteInput(inputUid: string): Promise<void> {
    const res = await fetch(`${base}/${inputUid}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`cloudflare live input delete failed: ${res.status}`);
    }
  }

  interface RecordingCleanupResult {
    deleted: number;
    failed: number;
    pending: number;
    seen: number;
  }

  /**
   * Delete every finished recording belonging to a live input.
   *
   * A stream that has just ended may not have a recording yet (Cloudflare can
   * take time to make one available). Callers use the returned pending/failure
   * counts to retain the input for a later sweep instead of orphaning video.
   *
   * Returns a lifecycle summary so callers can distinguish complete cleanup
   * from a safe deferral.
   */
  async function cleanupRecordings(inputUid: string): Promise<RecordingCleanupResult> {
    const listed = await fetch(`${base}/${inputUid}/videos`, { headers: authHeaders });
    if (!listed.ok) {
      throw new Error(`cloudflare recording list failed: ${listed.status}`);
    }

    const body = (await listed.json()) as VideoListResult;
    if (!body.success || !Array.isArray(body.result)) {
      throw new Error("cloudflare recording list returned an invalid response");
    }
    const videos = body.result ?? [];
    let deleted = 0;
    let failed = 0;
    let pending = 0;

    for (const video of videos) {
      const state = video.status?.state;
      if (state !== "ready" && state !== "error") {
        // Unknown and processing states are deliberately retained. Deleting
        // the input now would orphan a recording that Cloudflare has not
        // finished materializing yet.
        pending += 1;
        continue;
      }

      const res = await fetch(`${CF_API}/accounts/${accountId}/stream/${video.uid}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (res.ok || res.status === 404) deleted += 1;
      else failed += 1;
    }
    return { deleted, failed, pending, seen: videos.length };
  }

  async function listLiveInputs(): Promise<{
    inputs: LiveInputSummary[];
    total: number;
  }> {
    const listed = await fetch(base, { headers: authHeaders });
    if (!listed.ok) throw new Error(`cloudflare live input list failed: ${listed.status}`);

    const body = (await listed.json()) as LiveInputListResult;
    const inputs = body.result?.liveInputs;
    if (!body.success || !Array.isArray(inputs)) {
      throw new Error("cloudflare live input list returned an invalid response");
    }
    return { inputs, total: body.result?.total ?? inputs.length };
  }

  /**
   * Disable an input, delete terminal recordings, then delete the input only
   * when no recording can be orphaned. Explicit stops defer an empty recording
   * list because Cloudflare may still be materializing it; queue recovery can
   * accept an empty list after its grace period.
   */
  async function cleanupInput(
    inputUid: string,
    allowEmpty: boolean,
  ): Promise<StreamCleanupResult> {
    if (!(await disableInput(inputUid))) return { recordings: 0, input: "missing" };

    const cleanup = await cleanupRecordings(inputUid);
    if (cleanup.failed > 0) {
      throw new Error(`cloudflare recording cleanup failed for ${cleanup.failed} recording(s)`);
    }
    if (cleanup.pending > 0 || (!allowEmpty && cleanup.seen === 0)) {
      return { recordings: cleanup.deleted, input: "retained" };
    }

    await deleteInput(inputUid);
    return { recordings: cleanup.deleted, input: "deleted" };
  }

  async function reclaim(inputUid: string): Promise<StreamCleanupResult> {
    // A registry entry may refer to a live stream lasting longer than the
    // abandonment grace period. Verify provider state before disabling it.
    const current = await getLiveInput(inputUid);
    if (!current) return { recordings: 0, input: "missing" };
    if (isReclaimProtectedState(currentStatus(current).state)) {
      return { recordings: 0, input: "retained" };
    }
    return await cleanupInput(inputUid, true);
  }

  async function discover(): Promise<StreamDiscoveryResult> {
    const listed = await listLiveInputs();
    const inputs = listed.inputs.flatMap((input) => {
      if (!input.uid || !isMentraInput(input)) return [];
      const createdAt = Date.parse(input.created ?? input.modified ?? "");
      if (!Number.isFinite(createdAt)) return [];
      return [{ streamId: input.uid, createdAt }];
    });
    return { inputs, truncated: listed.total > listed.inputs.length };
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
      const input = await getLiveInput(streamId);
      if (!input) throw new Error("cloudflare live input status failed: input not found");
      const current = currentStatus(input);
      const state = current.state;
      return {
        streamId,
        isConnected: isConnectedState(state),
        state,
        connectedAt: current.statusEnteredAt,
        lastSeenAt: current.statusLastSeen,
        reason: current.reason,
      };
    },

    async stop(streamId: string): Promise<StreamCleanupResult> {
      return await cleanupInput(streamId, false);
    },

    reclaim,
    discover,
  };
}
