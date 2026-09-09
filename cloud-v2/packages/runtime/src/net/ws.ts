/**
 * @fileoverview Audio session — WebSocket lifecycle for cloud-v2 audio.
 *
 * A "session" here is the runtime audio pipeline for one connected client:
 *   - The WebSocket itself (transcripts down, control messages, audio fallback up)
 *   - The sessionTag — a u32 the client puts in every UDP packet header so any
 *     ingress pod can resolve "which user / which WS is this packet for"
 *   - Subscription state (transcription, translation — lands later)
 *   - Owner-pod claim in Redis (lands with OS-1504)
 *
 * Boot flow:
 *   1. Client opens WS to `/ws/session` with `Authorization: Bearer <access_token>`.
 *   2. We verify the access token via the shared verifier.
 *   3. We reserve a random u32 sessionTag in Redis with NX, then register it
 *      locally on open (fast-path lookup for same-pod packets). Redis makes
 *      cross-pod collision checks authoritative.
 *   4. Client sends `connection.init` (codec + initial subscriptions); we
 *      answer with `connection.ack` carrying the sessionTag + UDP coordinates.
 *   5. Client starts sending UDP packets with the sessionTag in the header;
 *      udp-ingress.service looks up the tag (local first, Redis on miss).
 *
 * The Redis registration is refreshed on a timer (well inside its TTL). If
 * a pod crashes without releasing, registrations TTL out and the next reconnect
 * (which mints a fresh tag) takes over cleanly.
 */

import crypto from "node:crypto";
import os from "node:os";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ulid } from "ulid";
import {
  AccessTokenError,
  createLogger,
  verifyRuntimeToken,
} from "@mentra/cloud-shared";
import {
  ingestAudioPacket,
  parseAudioPacket,
  refreshSessionTag,
  registerSessionTag,
  SESSION_TAG_REFRESH_INTERVAL_MS,
  unregisterSessionTag,
} from "../services/session/stream";
import {
  claimOwnershipWithRetry,
  releaseOwnership,
} from "../services/session/ownership";
import {
  assignUser,
  reconcileSubscriptions,
  releaseUser,
  setUserCodec,
} from "../services/audio/workers/pool";
import {
  deleteSubscriptionsIfSessionIn,
  readSubscriptions,
  refreshSubscriptions,
  seedSubscriptions,
  takeoverSubscriptions,
} from "../services/session/subscriptions-store";
import { clientToCloudMessage } from "@mentra/cloud-protocol/messages";
import { envelopeSchema, PROTOCOL_MAJOR } from "@mentra/cloud-protocol/envelope";
import type { ProtocolError, ProtocolErrorCode } from "@mentra/cloud-protocol/errors";
import { PROTOCOL_ERROR_CODES } from "@mentra/cloud-protocol/errors";
import type { ConnectionInit } from "@mentra/cloud-protocol/handshake";

const logger = createLogger("audio").child({ service: "session.service" });

const WS_PATH = "/ws/session";

/**
 * Protocol version this build speaks, echoed back in `connection.ack` as
 * `negotiatedVersion`. Bump the minor as backward-compatible message types
 * are added; bump the major (and `PROTOCOL_MAJOR`) only on a breaking change.
 */
const NEGOTIATED_VERSION = "2.0.0";

/**
 * What we put in connection.ack's `audio.udp` field. Set by `configureAudioSession`
 * at boot before Bun.serve goes live. Defaulted from env for the case where
 * something hits the WS endpoint before configure ran (shouldn't happen).
 */
let udpAdvertise = {
  host: process.env.AUDIO_UDP_ADVERTISED_HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.AUDIO_UDP_ADVERTISED_PORT ?? "8000", 10),
};

export function configureAudioSession(opts: {
  udpAdvertisedHost: string;
  udpAdvertisedPort: number;
}): void {
  udpAdvertise = {
    host: opts.udpAdvertisedHost,
    port: opts.udpAdvertisedPort,
  };
}

/** What we attach to each WebSocket. Available as `ws.data` in handlers. */
export interface WsData {
  /** u32, placed in every UDP packet header. */
  sessionTag: number;
  /** ULID. Identifies this audio session uniquely across pods. */
  audioSessionId: string;
  /** From the verified access token. */
  mentraUserId: string;
  tenantId: string;
  /** The auth-session id (from the access token's `session_id` claim). */
  authSessionId: string;
  /**
   * Per-session 32-byte UDP secretbox key, base64. Minted at upgrade so it is
   * available when we register the sessionTag at `open` (ingress on any pod
   * fetches it by sessionTag to decrypt). Delivered to the client in
   * `connection.ack.audio.encryption.key` over the TLS WebSocket, so the key
   * itself never travels over UDP. A fresh connection means a fresh key.
   */
  encryptionKeyB64: string;
  /** Epoch ms of the last inbound WS frame — passive liveness for takeover checks. */
  lastInboundAt: number;
  /**
   * Set when a newer socket for the same user takes over. The socket may
   * still be physically open for a short moment, but it must stop owning audio
   * subscriptions immediately.
   */
  supersededAt?: number;
}

export interface SessionEntry {
  ws: ServerWebSocket<WsData>;
  data: WsData;
}

const sessionByTag = new Map<number, SessionEntry>();

/**
 * Reference count of sessions per Mentra user on this pod. We need this for
 * release-on-close: when the last session for a user closes, we relinquish
 * the ownership claim. Multiple WSs from the same user to the same pod
 * (re-handshake without the old one closing yet) share the claim.
 */
const sessionsPerUser = new Map<string, number>();

/**
 * Debounced ownership releases. Releasing the Redis ownership claim the
 * instant the last socket closes loses a race with the user's own reconnect:
 * the replacement socket claims (or observes "already-ours") during upgrade,
 * BEFORE `open` increments the session count — then the old socket's close
 * sees count 0 and deletes the key out from under it. The ownership refresh
 * loop then finds the key missing, closes the new session with "ownership
 * lost", and the client reconnects into the same trap: an infinite churn
 * loop. Deferring the release a few seconds and cancelling it when a new
 * session opens makes plain reconnects race-free; a user who truly left still
 * releases after the grace period.
 */
const OWNERSHIP_RELEASE_GRACE_MS = 10_000;
const pendingOwnershipReleases = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleOwnershipRelease(mentraUserId: string): void {
  const existing = pendingOwnershipReleases.get(mentraUserId);
  if (existing) clearTimeout(existing);
  pendingOwnershipReleases.set(
    mentraUserId,
    setTimeout(() => {
      pendingOwnershipReleases.delete(mentraUserId);
      // Re-check: a session may have opened after the grace timer was set
      // but without passing through cancel (defensive; open() cancels).
      if (sessionsPerUser.has(mentraUserId)) return;
      releaseOwnership(mentraUserId, getPodId()).catch((err) => {
        logger.warn(
          { err, mentraUserId },
          "ownership release failed (will TTL out)",
        );
      });
    }, OWNERSHIP_RELEASE_GRACE_MS),
  );
}

function cancelPendingOwnershipRelease(mentraUserId: string): void {
  const pending = pendingOwnershipReleases.get(mentraUserId);
  if (pending) {
    clearTimeout(pending);
    pendingOwnershipReleases.delete(mentraUserId);
  }
}

// === Public API ===

/** Look up a session by its u32 tag. Used by udp-ingress to route packets. */
export function getSessionByTag(tag: number): SessionEntry | undefined {
  return sessionByTag.get(tag);
}

/** Number of active WS sessions on this pod. Useful for readiness/metrics. */
export function getActiveSessionCount(): number {
  return sessionByTag.size;
}

/** Mentra users this pod currently owns. Fed into the ownership refresh loop. */
export function getOwnedUserIds(): Iterable<string> {
  return sessionsPerUser.keys();
}

/** Detach local sessions after Redis says this pod no longer owns the user. */
export function dropUserSessionsForLostOwnership(mentraUserId: string): void {
  const entries = [...sessionByTag.values()].filter(
    (entry) => entry.data.mentraUserId === mentraUserId,
  );

  sessionsPerUser.delete(mentraUserId);
  releaseUser(mentraUserId);
  // Only delete the subscription key if it still belongs to one of the
  // sessions being dropped here. Losing ownership usually means ANOTHER pod
  // now owns this user and may have seeded the key for its own live session —
  // an unconditional delete from this stale pod would wipe that live state.
  deleteSubscriptionsIfSessionIn(
    mentraUserId,
    entries.map((entry) => entry.data.audioSessionId),
  ).catch((err) => {
    logger.warn(
      { err, mentraUserId },
      "subscription key delete failed after lost ownership",
    );
  });

  for (const entry of entries) {
    sessionByTag.delete(entry.data.sessionTag);
    const interval = refreshIntervals.get(entry.data.sessionTag);
    if (interval) {
      clearInterval(interval);
      refreshIntervals.delete(entry.data.sessionTag);
    }
    unregisterSessionTag(entry.data.sessionTag).catch((err) => {
      logger.warn(
        { err, sessionTag: entry.data.sessionTag },
        "sessionTag unregister failed after lost ownership",
      );
    });
    try {
      entry.ws.close(1012, "ownership lost");
    } catch (err) {
      logger.warn(
        { err, sessionTag: entry.data.sessionTag },
        "ws close failed after lost ownership",
      );
    }
  }
}

/**
 * A session is considered live for takeover purposes only while inbound
 * traffic has been seen recently. Clients ping every 15s (they own the
 * heartbeat — see the control.ping handler); a socket silent for several
 * multiples of that is half-open: its process died without a close frame
 * (force-stop, crash, network drop) and the close event may take minutes to
 * fire. We never CLOSE on silence (v1 nginx scars) — staleness only stops a
 * ghost from blocking another session's subscription takeover.
 */
const SESSION_LIVENESS_WINDOW_MS = 45_000;

/**
 * True iff the given audio session currently has an open, recently-active
 * WebSocket on this pod. Sessions for a user live only on the owning pod, so
 * when this pod owns the user, a `false` here means the session is dead
 * cluster-wide — used by the REST subscription endpoint to take over a dead
 * session's Redis record.
 */
export function hasLiveAudioSession(
  mentraUserId: string,
  audioSessionId: string,
): boolean {
  for (const entry of sessionByTag.values()) {
    if (
      entry.data.mentraUserId === mentraUserId &&
      entry.data.audioSessionId === audioSessionId
    ) {
      if (entry.data.supersededAt !== undefined) return false;
      return Date.now() - entry.data.lastInboundAt <= SESSION_LIVENESS_WINDOW_MS;
    }
  }
  return false;
}

/**
 * Send a worker-emitted message to all of the user's open WebSocket sessions
 * on this pod (typically one). Called by `worker-pool.onTranscript`.
 */
export function forwardToUserSessions(
  mentraUserId: string,
  message: unknown,
): void {
  const payload = JSON.stringify(message);
  for (const entry of sessionByTag.values()) {
    if (
      entry.data.mentraUserId === mentraUserId &&
      entry.data.supersededAt === undefined
    ) {
      try {
        entry.ws.send(payload);
      } catch (err) {
        logger.warn(
          { err, sessionTag: entry.data.sessionTag },
          "ws.send to forward worker transcript failed",
        );
      }
    }
  }
}

/**
 * If `req` targets the WS endpoint, attempt the upgrade. Returns:
 *   - `undefined` on success (Bun has already sent 101)
 *   - a `Response` to send back on failure (4xx)
 *   - `undefined` *also* when the path doesn't match — caller falls through
 *     to its HTTP handler. Detect "not for us" by checking the path yourself
 *     before calling; this helper does it but signals it via a sentinel.
 *
 * The pattern in `index.ts`:
 *   const wsResp = await tryWsUpgrade(req, server);
 *   if (wsResp !== HTTP_FALLTHROUGH) return wsResp;
 *   return healthApp.fetch(req);
 */
export const HTTP_FALLTHROUGH = Symbol("ws-upgrade-not-applicable");
export type WsUpgradeResult = Response | undefined | typeof HTTP_FALLTHROUGH;

export async function tryWsUpgrade(
  req: Request,
  server: Bun.Server<WsData>,
): Promise<WsUpgradeResult> {
  const url = new URL(req.url);
  if (url.pathname !== WS_PATH) return HTTP_FALLTHROUGH;

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("websocket upgrade required", { status: 426 });
  }

  // Auth: prefer the standard Bearer header, fall back to a `?token=` query
  // param. The mobile authenticates its WS via query param (React Native's
  // WebSocket can't reliably set headers), matching the v1 glasses-ws
  // pattern. Native test clients use the header.
  //
  // Auth failures at upgrade are fatal: the socket never opens. We return the
  // documented ProtocolError shape as the HTTP body (the WS isn't up yet, so we
  // cannot send an enveloped error frame). AUTH_EXPIRED vs AUTH_FAILED tells the
  // client whether refreshing the token and reopening is worth trying.
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : url.searchParams.get("token");
  if (!token) {
    return protocolErrorResponse("AUTH_FAILED", "missing or malformed Authorization");
  }

  let verified: Awaited<ReturnType<typeof verifyRuntimeToken>>;
  try {
    verified = await verifyRuntimeToken(token);
  } catch (err) {
    if (err instanceof AccessTokenError) {
      const code = isExpiredTokenError(err) ? "AUTH_EXPIRED" : "AUTH_FAILED";
      return protocolErrorResponse(code, err.message);
    }
    throw err;
  }

  // Ownership claim BEFORE upgrade: if another pod owns this user, reject
  // with 409. The client should retry — by retry time, either the other
  // pod releases on close, or its TTL expires. `claimOwnershipWithRetry`
  // already waits up to ~2× TTL for dying-owner scenarios.
  const podId = getPodId();
  const claim = await claimOwnershipWithRetry(verified.mentraUserId, podId);
  if (claim === "owned-by-other") {
    return new Response("user already owned by another pod", { status: 409 });
  }

  const audioSessionId = `audio_${ulid()}`;
  const encryptionKeyB64 = crypto.randomBytes(32).toString("base64");
  const tagRecord = {
    mentraUserId: verified.mentraUserId,
    tenantId: verified.tenantId,
    audioSessionId,
    authSessionId: verified.sessionId,
    podId,
    encryptionKeyB64,
  };
  let sessionTag: number;
  try {
    sessionTag = await reserveSessionTag(tagRecord);
  } catch (err) {
    if (claim === "claimed" && !sessionsPerUser.has(verified.mentraUserId)) {
      releaseOwnership(verified.mentraUserId, podId).catch(() => undefined);
    }
    logger.error(
      { err, mentraUserId: verified.mentraUserId },
      "failed to reserve sessionTag",
    );
    return new Response("could not reserve session tag", { status: 503 });
  }

  const data: WsData = {
    sessionTag,
    audioSessionId,
    mentraUserId: verified.mentraUserId,
    tenantId: verified.tenantId,
    authSessionId: verified.sessionId,
    // 32-byte secretbox key for this session. Stored in Redis with the reserved
    // sessionTag so any ingress pod can decrypt UDP frames. Sent to the client
    // at ack.
    encryptionKeyB64,
    lastInboundAt: Date.now(),
  };

  const upgraded = server.upgrade(req, { data });
  if (!upgraded) {
    // We claimed but failed to upgrade. Release the claim immediately so we
    // don't hold it for nothing — only if this is a fresh claim, not a
    // shared "already-ours" one (other sessions for this user might exist).
    if (claim === "claimed" && !sessionsPerUser.has(verified.mentraUserId)) {
      releaseOwnership(verified.mentraUserId, podId).catch(() => undefined);
    }
    unregisterSessionTag(sessionTag).catch(() => undefined);
    return new Response("upgrade failed", { status: 400 });
  }
  return undefined;
}

/**
 * Per-session Redis refresh intervals. Keyed by sessionTag so close() can
 * stop them.
 */
const refreshIntervals = new Map<number, ReturnType<typeof setInterval>>();

/**
 * Pod identity, computed ONCE per process. `os.hostname()` is NOT stable on
 * macOS (it flips between `<name>.local` and `Mac.localdomain` on network
 * changes); recomputing it per call made upgrade-time ownership claims use a
 * different pod id than the startup-captured refresh loop, so claims were
 * never renewed and every session dropped on TTL expiry in a ~2s churn loop.
 */
const POD_ID = process.env.POD_ID ?? process.env.HOSTNAME ?? os.hostname();

export function getPodId(): string {
  return POD_ID;
}

/** Bun WebSocket handlers — wire into `Bun.serve({ websocket: wsHandlers })`. */
export const wsHandlers: WebSocketHandler<WsData> = {
  open(ws) {
    sessionByTag.set(ws.data.sessionTag, { ws, data: ws.data });
    // A reconnect within the grace window keeps the existing ownership claim.
    cancelPendingOwnershipRelease(ws.data.mentraUserId);
    const wasFirst = !sessionsPerUser.has(ws.data.mentraUserId);
    sessionsPerUser.set(
      ws.data.mentraUserId,
      (sessionsPerUser.get(ws.data.mentraUserId) ?? 0) + 1,
    );

    // First session for this user on this pod → assign to a worker. The
    // worker subscribes to the user's stream and starts processing audio.
    // Subsequent sessions (rare — reconnect race) reuse the same worker.
    if (wasFirst) assignUser(ws.data.mentraUserId);
    logger.info(
      {
        sessionTag: ws.data.sessionTag,
        mentraUserId: ws.data.mentraUserId,
        audioSessionId: ws.data.audioSessionId,
        authSessionId: ws.data.authSessionId,
        liveCount: sessionsPerUser.get(ws.data.mentraUserId) ?? 0,
      },
      "ws session opened",
    );
    logger.info(
      {
        mentraUserId: ws.data.mentraUserId,
        sessionTag: ws.data.sessionTag,
        audioSessionId: ws.data.audioSessionId,
        authSessionId: ws.data.authSessionId,
        liveCount: sessionsPerUser.get(ws.data.mentraUserId) ?? 0,
      },
      "ws-session-debug opened",
    );

    // Refresh loop: keep the Redis registration AND the subscription key alive
    // while the WS is open. Both are TTL'd so an abandoned session (crashed pod)
    // cleans itself up; the owner refreshes them well inside the TTL.
    const interval = setInterval(() => {
      refreshSessionTag(ws.data.sessionTag).catch((err) => {
        logger.warn(
          { err, sessionTag: ws.data.sessionTag },
          "sessionTag refresh failed",
        );
      });
      // Session-scoped: only re-arms the TTL while the record belongs to THIS
      // session, so a dead session's record expires instead of being kept
      // alive by whichever socket reconnects next.
      refreshSubscriptions(ws.data.mentraUserId, ws.data.audioSessionId).catch((err) => {
        logger.warn(
          { err, mentraUserId: ws.data.mentraUserId },
          "subscription key refresh failed",
        );
      });
    }, SESSION_TAG_REFRESH_INTERVAL_MS);
    refreshIntervals.set(ws.data.sessionTag, interval);

    // No ack yet. In the v2 protocol the client sends `connection.init`
    // (carrying codec + initial subscriptions) and we answer with
    // `connection.ack`. See the message handler below. The session state
    // above (worker assignment, tag registration) is set up now so audio
    // packets that arrive the instant after the ack already have somewhere
    // to land.
  },

  message(ws, msg) {
    ws.data.lastInboundAt = Date.now();
    if (ws.data.supersededAt !== undefined) {
      try {
        ws.close(1012, "superseded by newer session");
      } catch {
        /* already closing */
      }
      return;
    }
    // String frames are v2 protocol control messages; binary frames are the
    // WS-fallback audio path (same 6-byte header + payload as UDP).
    if (typeof msg === "string") {
      let json: unknown;
      try {
        json = JSON.parse(msg);
      } catch {
        // Not JSON at all. Treat as a malformed request rather than dropping
        // silently, so the client learns its frame was rejected.
        sendProtocolError(ws, "BAD_REQUEST", "control frame is not valid JSON");
        return;
      }

      // Read the envelope shape first so we can classify failures per the error
      // model: a wrong protocol major is fatal, an unknown type is a non-fatal
      // nudge, and a known type with a bad payload is a non-fatal BAD_REQUEST.
      const major = (json as { v?: unknown })?.v;
      if (major !== PROTOCOL_MAJOR) {
        // Fatal: the client speaks a different protocol major. Tell it, then
        // close (sendProtocolError closes on a fatal code).
        sendProtocolError(
          ws,
          "UNSUPPORTED_VERSION",
          `unsupported protocol major: ${String(major)}`,
        );
        return;
      }

      const envParsed = envelopeSchema.safeParse(json);
      if (!envParsed.success) {
        sendProtocolError(ws, "BAD_REQUEST", "malformed message envelope");
        return;
      }

      // Known client-to-cloud types. An unrecognized type stays non-fatal so
      // new message types can be added within a major version (forward compat).
      if (!CLIENT_TO_CLOUD_TYPES.has(envParsed.data.type)) {
        sendProtocolError(
          ws,
          "UNKNOWN_TYPE",
          `unrecognized type: ${envParsed.data.type}`,
        );
        return;
      }

      // Type is known; now validate its payload. A failure here means the
      // payload is malformed for a known type: BAD_REQUEST, non-fatal.
      const parsed = clientToCloudMessage.safeParse(json);
      if (!parsed.success) {
        logger.debug(
          { sessionTag: ws.data.sessionTag, type: envParsed.data.type, issues: parsed.error.issues },
          "ws control message failed payload validation",
        );
        sendProtocolError(
          ws,
          "BAD_REQUEST",
          `malformed payload for ${envParsed.data.type}`,
        );
        return;
      }

      const m = parsed.data;
      switch (m.type) {
        case "connection.init":
          void handleConnectionInit(ws, m.payload);
          return;
        case "control.ping":
          // App-level liveness. **The client owns the heartbeat.** We answer
          // pings but never initiate our own, never enforce a short
          // idleTimeout, and never close a WS on silence / VAD inactivity.
          // Connection liveness is the client's responsibility.
          //
          // History: v1 burned weeks debugging "what kills my WS" — the root
          // cause was nginx ingress's proxy-send-timeout firing on CLIENT
          // silence, which server-side pings can't fix (they only reset the
          // server→client direction). The fix was app-level client pings plus
          // an nginx WS-ingress timeout bump. The V1 incident history was
          // retired with the V1 source tree.
          ws.send(
            JSON.stringify({
              v: PROTOCOL_MAJOR,
              type: "control.pong",
              timestamp: Date.now(),
              payload: {},
            }),
          );
          return;
        case "control.pong":
          // Client answering a (future) server-initiated ping. We don't send
          // those today, so nothing to do — accepted for forward compat.
          return;
      }
    } else {
      // Binary WS frame = audio-fallback path. Same 6-byte header + payload
      // wire format as UDP packets. We route through the SAME `ingestAudioPacket`
      // helper UDP uses, so dispatch/decode/provider are transport-agnostic.
      //
      // Real clients fall back to WS when UDP is blocked (corp firewall,
      // strict NAT, dev laptops behind home routers). It's the same path
      // v1 used via `bun-websocket.ts handleGlassesMessage`.
      void handleWsBinaryAudio(ws, msg as Buffer | Uint8Array);
    }
  },

  close(ws) {
    sessionByTag.delete(ws.data.sessionTag);

    const interval = refreshIntervals.get(ws.data.sessionTag);
    if (interval) {
      clearInterval(interval);
      refreshIntervals.delete(ws.data.sessionTag);
    }

    // Decrement per-user session count; if zero, release the ownership claim
    // AND detach the user from its worker.
    const currentCount = sessionsPerUser.get(ws.data.mentraUserId);
    if (currentCount !== undefined) {
      const remaining = currentCount - 1;
      if (remaining <= 0) {
        sessionsPerUser.delete(ws.data.mentraUserId);
        releaseUser(ws.data.mentraUserId);
        // Deferred: an immediate release races the user's own reconnect and
        // produces an "ownership lost" churn loop — see pendingOwnershipReleases.
        scheduleOwnershipRelease(ws.data.mentraUserId);
        // Drop the subscription key on a clean last-session close so the next
        // session for this user starts from its own seed, not stale subs — but
        // only when the key still belongs to THIS closing session: on a fast
        // reconnect the replacement socket may have seeded its own record
        // before this close handler runs. If this fails the key TTLs out.
        deleteSubscriptionsIfSessionIn(ws.data.mentraUserId, [
          ws.data.audioSessionId,
        ]).catch((err) => {
          logger.warn(
            { err, mentraUserId: ws.data.mentraUserId },
            "subscription key delete failed (will TTL out)",
          );
        });
      } else {
        sessionsPerUser.set(ws.data.mentraUserId, remaining);
      }
    }

    // Best-effort cleanup. If this fails the entry TTLs out shortly anyway.
    unregisterSessionTag(ws.data.sessionTag).catch((err) => {
      logger.warn(
        { err, sessionTag: ws.data.sessionTag },
        "sessionTag unregister failed (will TTL out)",
      );
    });

    const remainingLive = sessionsPerUser.get(ws.data.mentraUserId) ?? 0;
    logger.info(
      {
        sessionTag: ws.data.sessionTag,
        mentraUserId: ws.data.mentraUserId,
        audioSessionId: ws.data.audioSessionId,
        authSessionId: ws.data.authSessionId,
        superseded: ws.data.supersededAt !== undefined,
        remainingLive,
      },
      "ws session closed",
    );
    logger.info(
      {
        mentraUserId: ws.data.mentraUserId,
        sessionTag: ws.data.sessionTag,
        audioSessionId: ws.data.audioSessionId,
        authSessionId: ws.data.authSessionId,
        superseded: ws.data.supersededAt !== undefined,
        remainingLive,
      },
      "ws-session-debug closed",
    );
  },
};

// === Internals ===

/**
 * Handle a `connection.init`: seed the initial subscriptions and answer with
 * `connection.ack`. This is the v2 handshake's second half — the client opens
 * the WS (auth happens at upgrade), sends init with its codec + initial
 * subscriptions, and gets back the sessionTag and UDP coordinates it needs to
 * start streaming audio.
 */
async function handleConnectionInit(
  ws: ServerWebSocket<WsData>,
  init: ConnectionInit,
): Promise<void> {
  // Tell the worker this session's codec before any audio is processed, so it
  // knows whether to LC3-decode the stream entries or treat them as raw PCM.
  setUserCodec(
    ws.data.mentraUserId,
    init.audio?.codec ?? "lc3",
    init.audio?.frameSizeBytes,
  );
  supersedeOlderSessionsForUser(ws.data);

  // Seed the subscription source-of-truth key atomically with session creation,
  // so audio that starts flowing right after the ack is transcribed against the
  // right subscriptions instead of an empty set. We seed at version 0 with this
  // session's id (the same id the client echoes in REST writes); subsequent REST
  // writes are guarded against this baseline. If another still-live socket for
  // this user already seeded the key, the seed is ignored so we don't clobber
  // that session's guard. Mid-session changes arrive later via REST.
  const subs = init.audio?.initialSubscriptions ?? [];
  try {
    const seeded = await seedSubscriptions(ws.data.mentraUserId, {
      subscriptions: subs,
      sessionId: ws.data.audioSessionId,
      version: 0,
    });
    if (seeded) {
      // Nudge the local worker to reconcile from the freshly seeded key. The key
      // is the source of truth; the worker re-reads it rather than trusting any
      // passed snapshot. Cross-pod writes use the control stream instead.
      reconcileSubscriptions(ws.data.mentraUserId);
    } else {
      // Seed was refused because the key is held by another session. If that
      // session has no live socket it's dead cluster-wide (a user's sessions run
      // only on this owning pod), and deferring to it would wedge this fresh
      // session's subscriptions behind a ghost until the 60s TTL or the next REST
      // write. Take it over here — mirrors the REST dead-session takeover in
      // audio.api.ts so init and REST share one policy.
      const existing = await readSubscriptions(ws.data.mentraUserId);
      if (
        !existing ||
        !hasLiveAudioSession(ws.data.mentraUserId, existing.sessionId)
      ) {
        logger.warn(
          {
            mentraUserId: ws.data.mentraUserId,
            audioSessionId: ws.data.audioSessionId,
            deadSessionId: existing?.sessionId,
          },
          "connection.init taking over dead session's subscription record",
        );
        await takeoverSubscriptions(ws.data.mentraUserId, {
          subscriptions: subs,
          sessionId: ws.data.audioSessionId,
          version: 0,
        });
        reconcileSubscriptions(ws.data.mentraUserId);
      } else {
        logger.warn(
          { mentraUserId: ws.data.mentraUserId, audioSessionId: ws.data.audioSessionId },
          "connection.init subscription seed skipped; another live session is authoritative",
        );
      }
    }
  } catch (err) {
    // Do NOT fall through to connection.ack: without a seeded subscription key
    // the client would stream audio that is transcribed against nothing, with no
    // in-band signal anything is wrong. Surface the failure and close so the
    // client reconnects and re-runs the handshake cleanly.
    logger.error(
      { err, mentraUserId: ws.data.mentraUserId },
      "failed to seed subscriptions on connection.init; closing socket",
    );
    sendProtocolError(ws, "INTERNAL", "failed to initialize session");
    try {
      ws.close(1011, "init failed");
    } catch {
      /* already closing */
    }
    return;
  }

  ws.send(
    JSON.stringify({
      v: PROTOCOL_MAJOR,
      type: "connection.ack",
      timestamp: Date.now(),
      payload: {
        sessionId: ws.data.audioSessionId,
        negotiatedVersion: NEGOTIATED_VERSION,
        audio: {
          sessionTag: ws.data.sessionTag,
          udp: { host: udpAdvertise.host, port: udpAdvertise.port },
          // The per-session key was minted at upgrade and registered to Redis;
          // we deliver it here over the TLS WebSocket so it never rides UDP.
          encryption: {
            algorithm: "xsalsa20-poly1305",
            key: ws.data.encryptionKeyB64,
          },
        },
      },
    }),
  );

  logger.info(
    {
      sessionTag: ws.data.sessionTag,
      mentraUserId: ws.data.mentraUserId,
      codec: init.audio?.codec,
      initialSubCount: subs.length,
    },
    "connection.init handled; connection.ack sent",
  );
}

/**
 * WS-binary audio fallback. Same 6-byte header + payload as UDP. Routed via
 * the shared `ingestAudioPacket` so dispatch/decode/provider are identical
 * across transports. The local-session lookup will always hit because the
 * WS is by definition on this pod.
 */
async function handleWsBinaryAudio(
  ws: ServerWebSocket<WsData>,
  msg: Buffer | Uint8Array,
): Promise<void> {
  if (ws.data.supersededAt !== undefined) return;
  const packet = parseAudioPacket(msg);
  if (!packet) {
    logger.debug(
      { sessionTag: ws.data.sessionTag, len: msg.byteLength },
      "ws binary too small for audio header — ignoring",
    );
    return;
  }

  // The WS owns the session, so the sessionTag MUST be ours.
  if (packet.sessionTag !== ws.data.sessionTag) {
    logger.warn(
      {
        wsTag: ws.data.sessionTag,
        packetTag: packet.sessionTag,
      },
      "ws binary audio packet has mismatched sessionTag — dropping",
    );
    return;
  }

  try {
    await ingestAudioPacket(packet, (tag) => {
      const e = sessionByTag.get(tag);
      if (!e) return undefined;
      return {
        mentraUserId: e.data.mentraUserId,
        audioSessionId: e.data.audioSessionId,
      };
    });
  } catch (err) {
    logger.error(
      { err, sessionTag: ws.data.sessionTag },
      "ws binary audio ingest failed",
    );
  }
}

function supersedeOlderSessionsForUser(current: WsData): void {
  for (const entry of sessionByTag.values()) {
    const data = entry.data;
    if (data.sessionTag === current.sessionTag) continue;
    if (data.supersededAt !== undefined) continue;
    if (data.mentraUserId !== current.mentraUserId) continue;

    data.supersededAt = Date.now();
    const interval = refreshIntervals.get(data.sessionTag);
    if (interval) {
      clearInterval(interval);
      refreshIntervals.delete(data.sessionTag);
    }
    unregisterSessionTag(data.sessionTag).catch((err) => {
      logger.warn(
        { err, sessionTag: data.sessionTag },
        "sessionTag unregister failed after supersede",
      );
    });
    const dualClient = data.authSessionId !== current.authSessionId;
    logger.warn(
      {
        mentraUserId: data.mentraUserId,
        oldSessionTag: data.sessionTag,
        oldAudioSessionId: data.audioSessionId,
        oldAuthSessionId: data.authSessionId,
        newSessionTag: current.sessionTag,
        newAudioSessionId: current.audioSessionId,
        newAuthSessionId: current.authSessionId,
        dualClient,
        liveCount: sessionsPerUser.get(data.mentraUserId) ?? 0,
      },
      "ws session superseded by newer socket for same user",
    );
    logger.info(
      {
        mentraUserId: data.mentraUserId,
        oldSessionTag: data.sessionTag,
        oldAuthSessionId: data.authSessionId,
        newSessionTag: current.sessionTag,
        newAuthSessionId: current.authSessionId,
        dualClient,
        liveCount: sessionsPerUser.get(data.mentraUserId) ?? 0,
      },
      "ws-session-debug superseded",
    );
    try {
      entry.ws.close(1012, "superseded by newer session");
    } catch (err) {
      logger.warn(
        { err, sessionTag: data.sessionTag },
        "ws close failed after supersede",
      );
    }
  }
}

// === Error model helpers ===

/**
 * The message types the client may send to the cloud. Kept as a name set so an
 * unrecognized type can be answered with UNKNOWN_TYPE without paying for a full
 * union parse first. Mirrors the `clientToCloudMessage` discriminated union.
 */
const CLIENT_TO_CLOUD_TYPES = new Set<string>([
  "connection.init",
  "control.ping",
  "control.pong",
]);

/**
 * Send an enveloped `error` message on the WebSocket and, if the code is fatal,
 * close the socket after sending. This is the in-band error channel for frames
 * that arrive after the WS is open (auth failures happen at upgrade, before the
 * socket exists, and use `protocolErrorResponse` instead).
 */
function sendProtocolError(
  ws: ServerWebSocket<WsData>,
  code: ProtocolErrorCode,
  message: string,
): void {
  const fatal = PROTOCOL_ERROR_CODES[code].fatal;
  const payload: ProtocolError = { code, message, fatal };
  try {
    ws.send(
      JSON.stringify({
        v: PROTOCOL_MAJOR,
        type: "error",
        timestamp: Date.now(),
        payload,
      }),
    );
  } catch (err) {
    logger.warn({ err, code }, "failed to send protocol error frame");
  }
  if (fatal) {
    // Close after the error so the client sees why before the socket drops.
    // 1008 = policy violation, the closest standard code for a protocol error.
    try {
      ws.close(1008, code);
    } catch {
      /* already closing */
    }
  }
}

/**
 * Build the HTTP response body for an auth error at upgrade. The WS isn't open
 * yet, so we cannot send an enveloped frame; we return the ProtocolError shape
 * as JSON with a 401 so the client gets the documented contract either way.
 */
function protocolErrorResponse(
  code: ProtocolErrorCode,
  message: string,
): Response {
  const payload: ProtocolError = {
    code,
    message,
    fatal: PROTOCOL_ERROR_CODES[code].fatal,
  };
  return new Response(JSON.stringify(payload), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Classify an access-token verification failure as expiry vs everything else.
 * jose reports an expired token with an `exp`-claim message; the client uses
 * AUTH_EXPIRED as the signal to refresh and reopen rather than give up.
 */
function isExpiredTokenError(err: AccessTokenError): boolean {
  return /exp.*claim|expired/i.test(err.message);
}

/** Mint and reserve a u32 sessionTag across all pods. */
async function reserveSessionTag(record: Parameters<typeof registerSessionTag>[1]): Promise<number> {
  for (let i = 0; i < 16; i++) {
    const tag = crypto.randomBytes(4).readUInt32BE(0);
    if (sessionByTag.has(tag)) continue;
    if (await registerSessionTag(tag, record)) return tag;
  }
  // 1 in 4 billion, retried 16 times. Effectively impossible unless the Redis
  // registry is unavailable or the tag space is exhausted.
  throw new Error("could not reserve a unique sessionTag after 16 tries");
}
