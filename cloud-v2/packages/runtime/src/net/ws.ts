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
 *   3. We mint a random u32 sessionTag, register `tag → identity` BOTH locally
 *      (fast-path lookup for packets that land on this same pod) AND in Redis
 *      (so packets that land on other pods can still resolve who this is for).
 *   4. We send CONNECTION_ACK over the WS with sessionTag + UDP info.
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
  verifyAccessTokenSignature,
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
import { assignUser, releaseUser, updateSubscriptions } from "../services/audio/workers/pool";
import {
  parsePhoneSubscriptions,
  type PhoneSubscriptionUpdate,
} from "../wire/phone-protocol";

const logger = createLogger("audio").child({ service: "session.service" });

const WS_PATH = "/ws/session";

/**
 * What we put in CONNECTION_ACK's `udp` field. Set by `configureAudioSession`
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
  oemId: string;
  /** The auth-session id (from the access token's `session_id` claim). */
  authSessionId: string;
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
    if (entry.data.mentraUserId === mentraUserId) {
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
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : url.searchParams.get("token");
  if (!token) {
    return new Response("missing or malformed Authorization", { status: 401 });
  }

  let verified: Awaited<ReturnType<typeof verifyAccessTokenSignature>>;
  try {
    verified = await verifyAccessTokenSignature(token);
  } catch (err) {
    if (err instanceof AccessTokenError) {
      return new Response(err.message, { status: 401 });
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

  const sessionTag = mintSessionTag();
  const data: WsData = {
    sessionTag,
    audioSessionId: `audio_${ulid()}`,
    mentraUserId: verified.mentraUserId,
    oemId: verified.oemId,
    authSessionId: verified.sessionId,
  };

  const upgraded = server.upgrade(req, { data });
  if (!upgraded) {
    // We claimed but failed to upgrade. Release the claim immediately so we
    // don't hold it for nothing — only if this is a fresh claim, not a
    // shared "already-ours" one (other sessions for this user might exist).
    if (claim === "claimed" && !sessionsPerUser.has(verified.mentraUserId)) {
      releaseOwnership(verified.mentraUserId, podId).catch(() => undefined);
    }
    return new Response("upgrade failed", { status: 400 });
  }
  return undefined;
}

/**
 * Per-session Redis refresh intervals. Keyed by sessionTag so close() can
 * stop them.
 */
const refreshIntervals = new Map<number, ReturnType<typeof setInterval>>();

function getPodId(): string {
  return process.env.POD_ID ?? process.env.HOSTNAME ?? os.hostname();
}

/** Bun WebSocket handlers — wire into `Bun.serve({ websocket: wsHandlers })`. */
export const wsHandlers: WebSocketHandler<WsData> = {
  open(ws) {
    sessionByTag.set(ws.data.sessionTag, { ws, data: ws.data });
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
      },
      "ws session opened",
    );

    // Register in Redis so other pods can resolve this tag. Fire-and-forget;
    // local map is the fast-path so same-pod packets work even if this fails.
    registerSessionTag(ws.data.sessionTag, {
      mentraUserId: ws.data.mentraUserId,
      oemId: ws.data.oemId,
      audioSessionId: ws.data.audioSessionId,
      authSessionId: ws.data.authSessionId,
      podId: getPodId(),
    }).catch((err) => {
      logger.error(
        { err, sessionTag: ws.data.sessionTag },
        "failed to register sessionTag in Redis (cross-pod routing degraded for this session)",
      );
    });

    // Refresh loop: keep the Redis registration alive while the WS is open.
    const interval = setInterval(() => {
      refreshSessionTag(ws.data.sessionTag).catch((err) => {
        logger.warn(
          { err, sessionTag: ws.data.sessionTag },
          "sessionTag refresh failed",
        );
      });
    }, SESSION_TAG_REFRESH_INTERVAL_MS);
    refreshIntervals.set(ws.data.sessionTag, interval);

    ws.send(
      JSON.stringify({
        type: "CONNECTION_ACK",
        sessionTag: ws.data.sessionTag,
        audioSessionId: ws.data.audioSessionId,
        udp: { host: udpAdvertise.host, port: udpAdvertise.port },
      }),
    );
  },

  message(ws, msg) {
    // Control messages (subscriptions, etc.) land here once defined.
    // Binary frames are the WS-fallback audio path — defer to the same
    // dispatcher UDP packets use once dispatch ships.
    if (typeof msg === "string") {
      // App-level liveness from the client. **The client owns the heartbeat.**
      // We just respond to pings. Cloud-v2 deliberately does NOT initiate
      // its own pings, does NOT enforce an `idleTimeout` short enough to
      // close idle WSs, and does NOT close a WS based on silence / VAD
      // inactivity. Connection liveness is the client's responsibility.
      //
      // History: v1 burned weeks debugging "what kills my WS" — root cause
      // was nginx ingress's `proxy-send-timeout` firing on CLIENT silence,
      // which server-side pings can't fix (they only reset server→client
      // direction). Fix was app-level client pings + nginx WS-ingress
      // timeout bump to 1h. See cloud/issues/034-ws-liveness/ + 035 in v1.
      let parsed: { type?: string } | null = null;
      try {
        parsed = JSON.parse(msg) as { type?: string };
      } catch {
        /* not JSON; ignore for now */
      }
      if (parsed?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (parsed?.type === "phone_subscription_update") {
        // The phone sends a flat list of subscription strings on every
        // (re)connect — the v1 wire contract. We parse them into the internal
        // subscription shape (dropping any non-audio entries) and hand them to
        // the worker pool. No WS ACK; the next transcript-or-not is the
        // implicit confirmation.
        const raw = (parsed as PhoneSubscriptionUpdate).subscriptions;
        const rawList = Array.isArray(raw) ? raw : [];
        const subs = parsePhoneSubscriptions(rawList);
        updateSubscriptions(ws.data.mentraUserId, subs);
        logger.info(
          {
            sessionTag: ws.data.sessionTag,
            mentraUserId: ws.data.mentraUserId,
            rawCount: rawList.length,
            audioSubCount: subs.length,
          },
          "phone subscriptions updated",
        );
        return;
      }
      logger.debug(
        { sessionTag: ws.data.sessionTag, msg },
        "ws control message (no handlers wired yet)",
      );
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
    const remaining = (sessionsPerUser.get(ws.data.mentraUserId) ?? 1) - 1;
    if (remaining <= 0) {
      sessionsPerUser.delete(ws.data.mentraUserId);
      releaseUser(ws.data.mentraUserId);
      releaseOwnership(ws.data.mentraUserId, getPodId()).catch((err) => {
        logger.warn(
          { err, mentraUserId: ws.data.mentraUserId },
          "ownership release failed (will TTL out)",
        );
      });
    } else {
      sessionsPerUser.set(ws.data.mentraUserId, remaining);
    }

    // Best-effort cleanup. If this fails the entry TTLs out shortly anyway.
    unregisterSessionTag(ws.data.sessionTag).catch((err) => {
      logger.warn(
        { err, sessionTag: ws.data.sessionTag },
        "sessionTag unregister failed (will TTL out)",
      );
    });

    logger.info(
      { sessionTag: ws.data.sessionTag, mentraUserId: ws.data.mentraUserId },
      "ws session closed",
    );
  },
};

// === Internals ===

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

/** Mint a u32 sessionTag with a collision check against this pod's registry. */
function mintSessionTag(): number {
  for (let i = 0; i < 8; i++) {
    const tag = crypto.randomBytes(4).readUInt32BE(0);
    if (!sessionByTag.has(tag)) return tag;
  }
  // 1 in 4 billion, retried 8 times. Effectively impossible unless we have
  // ~hundreds of millions of concurrent sessions on one pod.
  throw new Error("could not mint a unique sessionTag after 8 tries");
}
