/**
 * Stateless Cloudflare-Stream proxy for phone-orchestrated managed live
 * inputs. Each request is a one-shot pass to CloudflareStreamService — no
 * registry, no lifecycle timers, no WebSocket emissions, no DB writes. The
 * only in-process state is `liveInputOwner` (best-effort, see its comment).
 *
 * Mounted at: /api/v2/client/streams/managed
 *
 * Endpoints:
 *   POST   /provision            — create live input + outputs, return URLs
 *   GET    /:liveInputId/status  — poll Cloudflare connection status
 *   DELETE /:liveInputId         — tear down live input
 */

import { Hono } from "hono";
import { clientAuth } from "../../middleware/client.middleware";
import { logger as rootLogger } from "../../../../services/logging/pino-logger";
import {
  CloudflareStreamService,
  type CreateLiveInputConfig,
} from "../../../../services/streaming/CloudflareStreamService";
import type { RestreamDestination } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../../types/hono";

const logger = rootLogger.child({ service: "v2.streams.api" });

// One service instance shared across requests. CloudflareStreamService is
// stateless (just an axios client + creds from env) so this is safe and saves
// the per-request `new` cost.
let serviceInstance: CloudflareStreamService | null = null;
function getService(): CloudflareStreamService {
  if (!serviceInstance) serviceInstance = new CloudflareStreamService(logger);
  return serviceInstance;
}

// Cheap ownership map: which user provisioned which Cloudflare live input.
// Strictly best-effort — purpose is to keep one authenticated user from
// tearing down or peeking at another user's stream. Loss across server
// restarts is acceptable: the worst case is an orphan liveInput that
// Cloudflare scavenges on its own schedule + an honest user has to re-
// provision. We intentionally don't use a DB here so this file stays
// stateless-enough to lift into cloud-2 unchanged.
const liveInputOwner: Map<string, string> = new Map();

const app = new Hono<AppEnv>();

app.post("/provision", clientAuth, handleProvision);
app.get("/:liveInputId/status", clientAuth, handleStatus);
app.delete("/:liveInputId", clientAuth, handleTeardown);

/**
 * POST /api/v2/client/streams/managed/provision
 *
 * Body: { restreamDestinations?: RestreamDestination[] }
 * Returns: { liveInputId, rtmpUrl, srtUrl?, hlsUrl, dashUrl, webrtcUrl?, webrtcPublishUrl?, outputs }
 *
 * The phone uses the returned ingest URL (`webrtcPublishUrl` for WHIP,
 * `srtUrl` for SRT, otherwise `rtmpUrl`) to command the glasses to start
 * publishing. Playback URLs go back to the miniapp as the
 * `session.stream.startManaged()` result.
 */
async function handleProvision(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const email = c.get("email")!;

  // Treat an empty body as "no destinations"; treat a non-empty body that
  // fails to parse as a client bug and surface 400. The previous
  // .catch(() => ({})) silently coerced bad JSON to an empty object, which
  // would provision a Cloudflare input the caller didn't really ask for.
  let body: Record<string, unknown> = {};
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      } else {
        return c.json(
          { success: false, message: "Request body must be a JSON object" },
          400,
        );
      }
    } catch {
      return c.json(
        { success: false, message: "Request body is not valid JSON" },
        400,
      );
    }
  }

  try {

    // restreamDestinations accepts either plain URL strings or
    // {url, name?} objects. Strings are normalized to objects; the canonical
    // RestreamDestination type (from @mentra/sdk) is what
    // CloudflareStreamService.createOutputs consumes. The stream key is
    // expected to be part of the URL (e.g. rtmp://yt/live/STREAM-KEY).
    let restreamDestinations: RestreamDestination[] | undefined;
    if (body.restreamDestinations !== undefined) {
      if (!Array.isArray(body.restreamDestinations)) {
        return c.json(
          { success: false, message: "restreamDestinations must be an array if provided" },
          400,
        );
      }
      restreamDestinations = [];
      for (const dest of body.restreamDestinations) {
        if (typeof dest === "string") {
          restreamDestinations.push({ url: dest });
          continue;
        }
        if (
          dest &&
          typeof dest === "object" &&
          typeof (dest as { url?: unknown }).url === "string"
        ) {
          const next: RestreamDestination = { url: (dest as { url: string }).url };
          const name = (dest as { name?: unknown }).name;
          if (typeof name === "string") next.name = name;
          restreamDestinations.push(next);
          continue;
        }
        return c.json(
          { success: false, message: "Each restream destination must be a URL string or {url, name?} object" },
          400,
        );
      }
    }

    const config: CreateLiveInputConfig = {
      ...(restreamDestinations ? { restreamDestinations } : {}),
    };

    const result = await getService().createLiveInput(email, config);
    liveInputOwner.set(result.liveInputId, email);

    reqLogger.info(
      { liveInputId: result.liveInputId, outputCount: result.outputs?.length ?? 0 },
      "v2 stream provisioned",
    );

    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reqLogger.error({ err }, "v2 stream provision failed");
    return c.json({ success: false, code: "provision_failed", message }, 502);
  }
}

/**
 * GET /api/v2/client/streams/managed/:liveInputId/status
 *
 * Returns: { isConnected, connectedAt?, disconnectedAt?, viewerCount? }
 *
 * The phone polls this every ~5s while a managed stream is active to surface
 * Cloudflare's view of the connection state to the miniapp. Glasses-side
 * status comes over BLE in real time; this is the confirmation signal.
 */
async function handleStatus(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const email = c.get("email")!;
  const liveInputId = c.req.param("liveInputId");

  if (!liveInputId) {
    return c.json({ success: false, message: "liveInputId required" }, 400);
  }
  if (!isOwnedBy(liveInputId, email)) {
    reqLogger.warn({ liveInputId }, "v2 stream status: caller is not the owner");
    return c.json({ success: false, code: "not_found", message: "Live input not found" }, 404);
  }

  try {
    const status = await getService().getLiveInputStatus(liveInputId);
    return c.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reqLogger.warn({ err, liveInputId }, "v2 stream status fetch failed");
    return c.json({ success: false, code: "status_failed", message }, 502);
  }
}

/**
 * DELETE /api/v2/client/streams/managed/:liveInputId
 *
 * Idempotent — succeeds whether the live input still exists or not.
 * Phone calls this when the last subscribing miniapp releases the stream.
 */
async function handleTeardown(c: AppContext) {
  const reqLogger = c.get("logger") || logger;
  const email = c.get("email")!;
  const liveInputId = c.req.param("liveInputId");

  if (!liveInputId) {
    return c.json({ success: false, message: "liveInputId required" }, 400);
  }
  if (!isOwnedBy(liveInputId, email)) {
    // Treat unknown / not-yours as 404 so callers can't enumerate inputs.
    reqLogger.warn({ liveInputId }, "v2 stream teardown: caller is not the owner");
    return c.json({ success: false, code: "not_found", message: "Live input not found" }, 404);
  }

  try {
    await getService().deleteLiveInput(liveInputId);
    liveInputOwner.delete(liveInputId);
    reqLogger.info({ liveInputId }, "v2 stream torn down");
    return c.json({ ok: true });
  } catch (err) {
    // CloudflareStreamService.deleteLiveInput swallows 404 already, so any
    // error here is a real Cloudflare or network problem.
    const message = err instanceof Error ? err.message : String(err);
    reqLogger.warn({ err, liveInputId }, "v2 stream teardown failed");
    return c.json({ success: false, code: "teardown_failed", message }, 502);
  }
}

/**
 * Owner check. The map is best-effort (in-memory, lost on restart). If we
 * don't know about a liveInput it could be (a) provisioned before the
 * current process started, (b) a probe by someone fishing for ids, or
 * (c) a race where teardown raced ahead of status. We deny (b) by
 * returning false on unknown; the legitimate (a)+(c) cost the user one
 * re-provision.
 */
function isOwnedBy(liveInputId: string, email: string): boolean {
  const owner = liveInputOwner.get(liveInputId);
  return owner !== undefined && owner === email;
}

export default app;
