/**
 * @fileoverview Audio service REST routes (Hono). Mounted at `/api/audio`.
 *
 * The one route today is the subscriptions endpoint: a client changes its
 * transcription / translation subscriptions mid-session with a single
 * authenticated PUT. The initial set rides in `connection.init` over the
 * WebSocket; this is how it changes afterward without reconnecting.
 *
 *   PUT /api/audio/subscriptions
 *   Authorization: Bearer <access_token>
 *   { subscriptions: AudioSubscription[], sessionId: string, version: number }
 *   -> 200 { applied, version, rejected }
 *
 * How a write reaches the worker (cross-pod safe, no pub/sub): the handler
 * writes the authoritative `{user:X}:subscriptions` Redis key through a guarded
 * Lua write (rejecting a stale session or an out-of-order version), then XADDs a
 * nudge to the user's `{user:X}:control` stream. The owning worker, wherever it
 * runs, already reads that stream and reconciles its providers from the key. So
 * a PUT that lands on a non-owner pod is still correct: it writes the shared key
 * and drops the nudge, and the owner picks it up. The `sessionId` + `version`
 * guard exists because the legacy system was bitten by out-of-order writes and
 * by a reconnect's empty snapshot wiping a live set; see subscriptions-store.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  AccessTokenError,
  createLogger,
  verifyRuntimeToken,
} from "@mentra/cloud-shared";
import { audioSubscriptionSchema } from "@mentra/cloud-protocol/audio";
import {
  takeoverSubscriptions,
  writeSubscriptions,
} from "../services/session/subscriptions-store";
import { publishSubscriptionsChanged } from "../services/session/control-stream";
import { hasLiveAudioSession } from "../net/ws";

const logger = createLogger("audio").child({ service: "audio.api" });

const subscriptionsBodySchema = z.object({
  subscriptions: z.array(audioSubscriptionSchema),
  // Echoed from connection.ack.sessionId so the cloud can reject writes from a
  // stale session (for example one that reconnected under a new session).
  sessionId: z.string().min(1),
  // Monotonic per snapshot, owned by the client. A write must be strictly newer
  // than the last accepted version for this session to apply.
  version: z.number().int().nonnegative(),
});

export const audioApi = new Hono();

audioApi.put("/subscriptions", async (c) => {
  // Auth: standard Bearer header, with a `?token=` fallback for clients that
  // can't set headers (matches the WS upgrade path).
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : c.req.query("token");
  if (!token) {
    return c.json({ error: "missing or malformed Authorization" }, 401);
  }

  let verified: Awaited<ReturnType<typeof verifyRuntimeToken>>;
  try {
    verified = await verifyRuntimeToken(token);
  } catch (err) {
    if (err instanceof AccessTokenError) {
      return c.json({ error: err.message }, 401);
    }
    throw err;
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = subscriptionsBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: "invalid subscriptions body", issues: parsed.error.issues },
      400,
    );
  }
  const { subscriptions, sessionId, version } = parsed.data;

  let result = await writeSubscriptions(verified.mentraUserId, {
    subscriptions,
    sessionId,
    version,
  });

  // Dead-session takeover. A "stale-session" rejection is correct when the
  // recorded session is a live socket (multi-device, or a reconnect race where
  // the old socket is still draining). But when the recorded session is GONE —
  // e.g. it died without clean teardown — deferring to it wedges the live
  // session's subscriptions behind a ghost. Sessions for a user run only on
  // the owning pod, so when the WRITER's session has a live socket here (this
  // pod owns the user) and the recorded session does not, the recorded session
  // is dead cluster-wide and the live session takes the key over.
  if (
    !result.applied &&
    result.reason === "stale-session" &&
    result.currentSessionId &&
    hasLiveAudioSession(verified.mentraUserId, sessionId) &&
    !hasLiveAudioSession(verified.mentraUserId, result.currentSessionId)
  ) {
    logger.warn(
      {
        mentraUserId: verified.mentraUserId,
        deadSessionId: result.currentSessionId,
        takeoverSessionId: sessionId,
      },
      "subscriptions takeover: recorded session has no live socket",
    );
    await takeoverSubscriptions(verified.mentraUserId, {
      subscriptions,
      sessionId,
      version,
    });
    result = { applied: true, version };
  }

  // Only nudge the worker when the write actually changed the source of truth.
  // A rejected (stale) write leaves the live set in place, so there is nothing
  // to reconcile.
  if (result.applied) {
    await publishSubscriptionsChanged(verified.mentraUserId, result.version);
  }

  logger.info(
    {
      mentraUserId: verified.mentraUserId,
      applied: result.applied,
      version: result.version,
      reason: result.reason,
      count: subscriptions.length,
      writerSessionId: sessionId,
      holderSessionId: result.currentSessionId,
      writerLive: hasLiveAudioSession(verified.mentraUserId, sessionId),
      holderLive: result.currentSessionId
        ? hasLiveAudioSession(verified.mentraUserId, result.currentSessionId)
        : undefined,
    },
    "subscriptions write",
  );

  // `rejected` is reserved for per-subscription rejections (an unsupported
  // language, say). Nothing is unsupported today, so it is always empty; the
  // field is wired so clients can rely on its presence.
  return c.json(
    {
      applied: result.applied,
      version: result.version,
      reason: result.reason ?? null,
      rejected: [] as Array<{ subscription: unknown; reason: string }>,
    },
    200,
  );
});
