/**
 * @fileoverview Camera service REST routes (Hono). Mounted at `/api/camera`.
 *
 * Thin HTTP over camera.service (which sits on the storage service). Endpoints:
 *
 *   POST   /api/camera/photo       -> { requestId, uploadUrl, readUrl }
 *   POST   /api/camera/stream      -> { streamId, ingest, playback }
 *   GET    /api/camera/stream/:id  -> { streamId, isConnected, state, ... }
 *   DELETE /api/camera/stream/:id  -> { streamId, status: "stopped" }
 *
 * Plus the storage plumbing:
 *   PUT/GET /api/camera/blob/:key  -> local provider only: the runtime serves
 *                                     its own blob bytes. A PUT (the device
 *                                     uploading) marks the photo complete.
 *   POST    /api/camera/storage-events -> the r2/s3 completion webhook: the
 *                                     provider's object-created event reaches
 *                                     here and marks the photo complete.
 *
 */

import { Hono, type Context } from "hono";
import {
  AccessTokenError,
  createLogger,
  verifyRuntimeToken,
} from "@mentra/cloud-shared";
import { photoOptionsSchema, streamOptionsSchema } from "@mentra/cloud-protocol/camera";
import { getStorageProvider } from "../services/storage/storage.service";
import * as camera from "../services/camera/camera.service";

const logger = createLogger("audio").child({ service: "camera.api" });

/** Shared secret the storage webhook requires, if configured. */
const WEBHOOK_SECRET = process.env.CAMERA_WEBHOOK_SECRET;

export const cameraApi = new Hono();

/**
 * Return the public origin that reached the TLS-terminating ingress.
 *
 * Runtime receives plain HTTP from ingress-nginx after TLS termination, while
 * devices must use the original HTTPS origin for generated photo URLs. The
 * ingress overwrites x-forwarded-proto and preserves Host, so no per-cluster
 * public URL configuration is required. Direct local requests have no
 * forwarded header and keep their actual protocol.
 */
export function publicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

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
    const verified = await verifyRuntimeToken(token);
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

  // The local provider builds absolute URLs back at this runtime; pass the
  // origin the client used so the device/test can reach them.
  const origin = publicOrigin(c);
  const result = await camera.requestPhoto(auth.mentraUserId, parsed.data, origin);
  return c.json(result, 200);
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

  const result = await camera.startStream(auth.mentraUserId, parsed.data);
  return c.json(result, 200);
});

cameraApi.get("/stream/:id", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;
  const streamId = c.req.param("id");
  const result = await camera.streamStatus(auth.mentraUserId, streamId);
  return c.json(result, 200);
});

cameraApi.delete("/stream/:id", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;
  const streamId = c.req.param("id");
  await camera.stopStream(auth.mentraUserId, streamId);
  return c.json({ streamId, status: "stopped" }, 200);
});

// --- Local provider blob serving (the runtime IS the upload endpoint) -------
//
// These exist only for the local provider; the r2/s3 byte path goes straight to
// the provider. They are unauthenticated dev endpoints (the "presigned" local
// URL is not actually signed), which is acceptable for local dev / CI.

async function readUploadBody(c: Context): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  const contentType = c.req.header("content-type") ?? "application/octet-stream";
  // Glasses firmware uploads multipart/form-data (a "photo" file part) rather
  // than a raw body; accept both so devices can hit the local upload endpoint
  // directly. Presigned r2/s3 URLs remain PUT-only — this is local-provider
  // convenience for dev and CI.
  if (contentType.startsWith("multipart/form-data")) {
    const form = await c.req.formData();
    const values = [...form.values()] as unknown[];
    const file = values.find((v): v is File => typeof v !== "string" && typeof (v as Blob)?.arrayBuffer === "function");
    if (!file) throw new Error("multipart upload missing a file part");
    return { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || "image/jpeg" };
  }
  return { bytes: new Uint8Array(await c.req.arrayBuffer()), contentType };
}

async function handleBlobUpload(c: Context) {
  const provider = getStorageProvider();
  if (!provider.servesBytes || !provider.put) {
    return c.json({ error: "blob upload not served by this provider" }, 404);
  }
  const key = c.req.param("key");
  if (!key) return c.json({ error: "missing key" }, 400);
  const { bytes, contentType } = await readUploadBody(c);
  await provider.put(key, bytes, contentType);
  // The runtime served the upload, so completion is known now.
  await camera.completeUpload(key);
  logger.info({ key, bytes: bytes.byteLength }, "local blob uploaded");
  return c.body(null, 204);
}

cameraApi.put("/blob/:key{.+}", handleBlobUpload);
// Glasses firmware POSTs multipart; accept it on the same route.
cameraApi.post("/blob/:key{.+}", handleBlobUpload);

cameraApi.get("/blob/:key{.+}", async (c) => {
  const provider = getStorageProvider();
  if (!provider.servesBytes || !provider.get) {
    return c.json({ error: "blob download not served by this provider" }, 404);
  }
  const key = c.req.param("key");
  const obj = await provider.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.bytes, {
    status: 200,
    headers: { "Content-Type": obj.contentType },
  });
});

// --- Storage completion webhook (r2/s3) -------------------------------------
//
// The provider's object-created event (R2 event notifications via a Cloudflare
// Queue + Worker, or an S3 event) is delivered here to mark the photo complete.
// Authenticated by a shared secret rather than a user token, since the caller is
// the storage provider, not the device.

cameraApi.post("/storage-events", async (c) => {
  if (WEBHOOK_SECRET && c.req.header("x-storage-webhook-secret") !== WEBHOOK_SECRET) {
    return c.json({ error: "invalid webhook secret" }, 401);
  }
  let body: { key?: string } = {};
  try {
    body = (await c.req.json()) as { key?: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.key) return c.json({ error: "missing key" }, 400);
  await camera.completeUpload(body.key);
  return c.body(null, 204);
});
