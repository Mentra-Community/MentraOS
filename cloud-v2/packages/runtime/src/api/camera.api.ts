/**
 * @fileoverview Camera service REST routes (Hono). Mounted at `/api/camera`.
 *
 * Two client-initiated capabilities, both stateless REST (no audio-session or
 * owner-pod coupling):
 *
 *   POST   /api/camera/photo      -> { requestId, uploadUrl, readUrl }
 *   POST   /api/camera/stream     -> { streamId, ingest, playback }
 *   DELETE /api/camera/stream/:id -> { streamId, status: "stopped" }
 *
 * (camera/spec.md also lists GET /api/camera/stream/:id for status; it has no
 * client consumer yet, so it lands when something needs it.)
 *
 * Managed photo is a request-then-push flow: the POST returns the presigned
 * upload + read URLs immediately, the capture happens out of band on the
 * glasses, and the cloud pushes `photo.ready` (or `photo.error`) over the user's
 * WebSocket when the upload lands. Managed stream is fully answered by the REST
 * response (ingest + playback coordinates), no push.
 *
 * PROVIDER: this build ships a MOCK provider (CAMERA_PROVIDER=mock, the default)
 * so the path is testable without real glasses or blob storage: a photo request
 * schedules a `photo.ready` push with a stub URL after a short simulated-capture
 * delay, and a stream request returns stub coordinates. The real provider
 * (Cloudflare R2/Stream, Alibaba OSS per region) lands behind CAMERA_PROVIDER
 * when the storage wrapper is built. The wire contract is identical either way.
 *
 * NOTE on push routing: the `photo.ready` push is delivered to the user's WS on
 * THIS pod. That holds when the request lands on the pod owning the user's WS
 * (the common case, since the client dials its connected pod). Cross-pod
 * delivery (REST on pod A, WS on pod B) needs the same owner-routing the audio
 * path uses and lands with it.
 *
 * Spec: docs/issues/002-cloud-runtime/camera/spec.md.
 */

import { ulid } from "ulid";
import { Hono, type Context } from "hono";
import {
  AccessTokenError,
  createLogger,
  verifyAccessTokenSignature,
} from "@mentra/cloud-shared";
import { PROTOCOL_MAJOR } from "../protocol/envelope";
import { photoOptionsSchema, streamOptionsSchema } from "../protocol/camera";
import { forwardToUserSessions } from "../net/ws";

const logger = createLogger("audio").child({ service: "camera.api" });

const CAMERA_PROVIDER = process.env.CAMERA_PROVIDER ?? "mock";
/** Mock simulated-capture delay before the `photo.ready` push (ms). */
const MOCK_CAPTURE_MS = Number.parseInt(
  process.env.CAMERA_MOCK_CAPTURE_MS ?? "100",
  10,
);

export const cameraApi = new Hono();

/** Verify the Bearer access token; returns the mentraUserId or an error Response. */
async function authUser(
  c: Context,
): Promise<{ mentraUserId: string } | { error: Response }> {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : c.req.query("token");
  if (!token) {
    return { error: c.json({ error: "missing or malformed Authorization" }, 401) };
  }
  try {
    const verified = await verifyAccessTokenSignature(token);
    return { mentraUserId: verified.mentraUserId };
  } catch (err) {
    if (err instanceof AccessTokenError) {
      return { error: c.json({ error: err.message }, 401) };
    }
    throw err;
  }
}

cameraApi.post("/photo", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    /* an empty body is fine: a default photo */
  }
  const parsed = photoOptionsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid photo options", issues: parsed.error.issues }, 400);
  }

  const requestId = `photo_${ulid()}`;
  // Stub presigned URLs. With a real provider these come from R2/OSS.
  const uploadUrl = `https://mock-camera.local/upload/${requestId}`;
  const readUrl = `https://mock-camera.local/photos/${requestId}.jpg`;

  if (CAMERA_PROVIDER === "mock") {
    // Simulate the out-of-band capture + upload, then push photo.ready to the
    // user's WS. The delay gives the client time to record its pending request
    // from this POST's response before the push arrives.
    setTimeout(() => {
      forwardToUserSessions(auth.mentraUserId, {
        v: PROTOCOL_MAJOR,
        type: "photo.ready",
        timestamp: Date.now(),
        payload: { requestId, readUrl },
      });
    }, MOCK_CAPTURE_MS);
  }

  logger.info({ mentraUserId: auth.mentraUserId, requestId }, "managed photo requested");
  return c.json({ requestId, uploadUrl, readUrl }, 200);
});

cameraApi.post("/stream", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = streamOptionsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "invalid stream options", issues: parsed.error.issues }, 400);
  }

  const streamId = `stream_${ulid()}`;
  // Stub coordinates. With a real provider these come from Cloudflare Stream.
  const result = {
    streamId,
    ingest: { url: `rtmps://mock-camera.local/ingest/${streamId}` },
    playback: { url: `https://mock-camera.local/play/${streamId}.m3u8` },
  };

  logger.info({ mentraUserId: auth.mentraUserId, streamId }, "managed stream provisioned");
  return c.json(result, 200);
});

cameraApi.delete("/stream/:id", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;
  const streamId = c.req.param("id");
  logger.info({ mentraUserId: auth.mentraUserId, streamId }, "managed stream stopped");
  // With a real provider this tears down the provider stream.
  return c.json({ streamId, status: "stopped" }, 200);
});
