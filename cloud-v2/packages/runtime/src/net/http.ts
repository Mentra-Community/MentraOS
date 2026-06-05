/**
 * @fileoverview Audio service REST endpoints (non-WebSocket HTTP).
 *
 * Today this is just the subscriptions endpoint: a client changes its
 * transcription / translation subscriptions mid-session with a single
 * authenticated PUT. The initial set rides in `connection.init` over the
 * WebSocket; this is how it changes afterward without reconnecting.
 *
 *   PUT /api/audio/subscriptions
 *   Authorization: Bearer <access_token>
 *   { "subscriptions": AudioSubscription[] }
 *   -> 204 No Content
 *
 * NOTE on routing: the update is applied to the worker on THIS pod. That is
 * correct when the request lands on the pod that owns the user (the common
 * case, since the client holds its WS to that pod and dials the same host for
 * REST). Cross-pod forwarding — PUT lands on pod A, user owned by pod B —
 * lands with the owner-routing work; until then a misrouted PUT is a no-op.
 */

import {
  AccessTokenError,
  createLogger,
  verifyAccessTokenSignature,
} from "@mentra/cloud-shared";
import { z } from "zod";
import { audioSubscriptionSchema } from "../protocol/audio";
import { updateSubscriptions } from "../services/audio/workers/pool";

const logger = createLogger("audio").child({ service: "http" });

const SUBSCRIPTIONS_PATH = "/api/audio/subscriptions";

const subscriptionsBodySchema = z.object({
  subscriptions: z.array(audioSubscriptionSchema),
});

/**
 * Handle an audio REST request. Returns a `Response` if the path is ours, or
 * `undefined` to let the caller fall through to the next handler (health).
 */
export async function tryAudioRest(req: Request): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname !== SUBSCRIPTIONS_PATH) return undefined;
  if (req.method !== "PUT") {
    return new Response("method not allowed", { status: 405 });
  }

  // Same auth as the WS upgrade: Bearer header, or a `?token=` fallback for
  // clients that can't set headers.
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  const parsed = subscriptionsBodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: "invalid subscriptions", issues: parsed.error.issues }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  updateSubscriptions(verified.mentraUserId, parsed.data.subscriptions);
  logger.info(
    { mentraUserId: verified.mentraUserId, count: parsed.data.subscriptions.length },
    "subscriptions updated via REST",
  );
  return new Response(null, { status: 204 });
}
