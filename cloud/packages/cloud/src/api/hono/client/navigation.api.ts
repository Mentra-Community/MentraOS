/**
 * @fileoverview Hono navigation API routes.
 *
 * Server-side proxy for the Google web-service APIs used by the mobile
 * navigation feature (Routes API + Geocoding API). The web-service key
 * (`GOOGLE_NAV_API_KEY`) lives only on the cloud and is never shipped in the
 * app — unlike the on-device Maps/Navigation SDK key, which must stay in the
 * app and is locked down by application restriction in GCP.
 *
 * These endpoints are thin pass-throughs: the mobile client sends the same
 * request bodies it used to send to Google directly, and we return Google's
 * raw response unchanged. All decoding / road-name resolution stays on the
 * client so there is no parsing logic to keep in sync across two codebases.
 *
 * The upstream calls, caching, and in-flight dedup live in
 * services/client/navigation.service.ts; these handlers only validate input,
 * rate-limit, and map service results to HTTP.
 *
 * Mounted at: /api/client/navigation
 */

import { Hono } from "hono";
import { clientAuth } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { computeRoute, reverseGeocode, type NavProxyResult } from "../../../services/client/navigation.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "navigation.api" });

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Per-user rate limit (same shape as device-state.api.ts, issue 099).
//
// These endpoints spend real GCP money per request, and an accidental client
// render loop must not be able to turn into an unbounded Google bill. The
// service-level cache absorbs identical repeats; this limiter caps what an
// errant client can make us do at all. Keyed on the authed email (no session
// required on these routes); pod-sticky clients make in-memory state
// sufficient, and a pod miss just resets a counter.
// ---------------------------------------------------------------------------

// One route compute per reroute is normal usage; 10 per window only triggers
// on bugs.
const ROUTE_RATE_LIMIT_MAX = 10;
// The mobile road-name resolver reverse-geocodes step midpoints in parallel
// (Promise.all in roadNameResolver.resolveStepRoads), so one legitimate
// route compute can burst dozens of calls — and a user previewing several
// destinations stacks a few bursts inside one window. The route limiter
// caps how many bursts can be triggered at all and the geocode cache makes
// repeated coordinates free, so this ceiling only needs to stop sustained
// unique-coordinate floods, not legitimate bursts.
const GEOCODE_RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_WARN_THROTTLE_MS = 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const RATE_LIMIT_ENTRY_MAX_AGE_MS = 5 * 60_000;

type RateLimitEntry = { count: number; windowStart: number; lastWarnAt: number };

function makeRateLimiter(name: string, maxPerWindow: number) {
  const state = new Map<string, RateLimitEntry>();

  // Background sweep so idle users' counters don't pin memory. unref() so
  // the interval doesn't block shutdown.
  setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_ENTRY_MAX_AGE_MS;
    for (const [userId, entry] of state) {
      if (entry.windowStart < cutoff) {
        state.delete(userId);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();

  return async function rateLimit(c: AppContext, next: () => Promise<void>) {
    const userId = c.get("email")!;
    const now = Date.now();

    const existing = state.get(userId);
    if (!existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
      state.set(userId, {
        count: 1,
        windowStart: now,
        lastWarnAt: existing?.lastWarnAt ?? 0,
      });
      await next();
      return;
    }

    existing.count += 1;
    if (existing.count > maxPerWindow) {
      if (now - existing.lastWarnAt > RATE_LIMIT_WARN_THROTTLE_MS) {
        existing.lastWarnAt = now;
        logger.warn(
          {
            userId,
            feature: name,
            count: existing.count,
            windowMs: RATE_LIMIT_WINDOW_MS,
            limit: maxPerWindow,
          },
          `Rate-limited /api/client/navigation/${name} — client is sending too many requests`,
        );
      }
      const retryAfterSec = Math.ceil((existing.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
      c.header("Retry-After", String(Math.max(retryAfterSec, 1)));
      return c.json({ error: "Too Many Requests" }, 429);
    }

    await next();
  };
}

const routeRateLimit = makeRateLimiter("route", ROUTE_RATE_LIMIT_MAX);
const geocodeRateLimit = makeRateLimiter("reverse-geocode", GEOCODE_RATE_LIMIT_MAX);

// ============================================================================
// Routes
// ============================================================================

// clientAuth only — deliberately NO requireUserSession. These are stateless
// REST pass-throughs that need identity, not a live WebSocket session: a
// route request must still work while the app's WS is down/reconnecting
// (e.g. right after app resume), where a session requirement would 503.
app.post("/route", clientAuth, routeRateLimit, handleComputeRoute);
app.post("/reverse-geocode", clientAuth, geocodeRateLimit, handleReverseGeocode);

// ============================================================================
// Handlers
// ============================================================================

/** Map a service result to the HTTP response, logging upstream failures. */
function respond(c: AppContext, result: NavProxyResult, apiName: string, email: string) {
  const reqLogger = c.get("logger") || logger;
  switch (result.kind) {
    case "ok":
      // Pass Google's JSON through unchanged; the client decodes it.
      return c.body(result.body, 200, { "Content-Type": "application/json" });
    case "not_configured":
      reqLogger.error(`GOOGLE_NAV_API_KEY is not set — ${apiName} proxy unavailable`);
      return c.json({ success: false, message: "Navigation service not configured" }, 503);
    case "upstream_error":
      // Google's error body carries the useful detail (INVALID_ARGUMENT,
      // malformed waypoints, ...) — log it truncated so failures are
      // debuggable, but keep the client response generic.
      reqLogger.warn({ status: result.status, body: result.body.slice(0, 500) }, `${apiName} error for user ${email}`);
      return c.json({ success: false, message: `${apiName} ${result.status}` }, 502);
    case "error":
      reqLogger.error(result.error, `Error proxying ${apiName} for user ${email}`);
      return c.json({ success: false, message: `Failed to call ${apiName}` }, 500);
  }
}

/**
 * POST /api/client/navigation/route
 *
 * Proxies the Google Routes API. The request body is the Routes API request
 * body the client built (origin, destination, intermediates, travelMode,
 * routeModifiers, polylineQuality, ...). Returns the Routes API JSON verbatim.
 */
async function handleComputeRoute(c: AppContext) {
  const email = c.get("email")!;

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ success: false, message: "request body required" }, 400);
  }

  const result = await computeRoute(body as Record<string, unknown>);
  return respond(c, result, "Routes API", email);
}

/**
 * POST /api/client/navigation/reverse-geocode
 *
 * Proxies the Google Geocoding API for a single coordinate.
 * Body: { lat: number, lng: number }
 * Returns the Geocoding API JSON verbatim.
 */
async function handleReverseGeocode(c: AppContext) {
  const email = c.get("email")!;

  const body = await c.req.json().catch(() => ({}));
  const { lat, lng } = body as { lat?: unknown; lng?: unknown };
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return c.json({ success: false, message: "valid lat/lng required" }, 400);
  }

  const result = await reverseGeocode(latNum, lngNum);
  return respond(c, result, "Geocoding API", email);
}

export default app;
