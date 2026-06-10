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
 * Mounted at: /api/client/navigation
 */

import { Hono } from "hono";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "navigation.api" });

const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GEOCODING_API_URL = "https://maps.googleapis.com/maps/api/geocode/json";

// Field mask the client relies on — must match the fields the mobile codec
// decodes (NavigationService.computeRouteViaRoutesApi).
const ROUTES_FIELD_MASK = [
  "routes.polyline.encodedPolyline",
  "routes.distanceMeters",
  "routes.duration",
  "routes.description",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.navigationInstruction",
].join(",");

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/route", clientAuth, requireUserSession, computeRoute);
app.post("/reverse-geocode", clientAuth, requireUserSession, reverseGeocode);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/navigation/route
 *
 * Proxies the Google Routes API. The request body is the Routes API request
 * body the client built (origin, destination, intermediates, travelMode,
 * routeModifiers, polylineQuality, ...). Returns the Routes API JSON verbatim.
 */
async function computeRoute(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  const apiKey = process.env.GOOGLE_NAV_API_KEY;
  if (!apiKey) {
    reqLogger.error("GOOGLE_NAV_API_KEY is not set — navigation route proxy unavailable");
    return c.json({ success: false, message: "Navigation service not configured" }, 503);
  }

  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ success: false, message: "request body required" }, 400);
    }

    const res = await fetch(ROUTES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      reqLogger.warn({ status: res.status }, `Routes API error for user ${userSession.userId}`);
      return c.json({ success: false, message: `Routes API ${res.status}` }, 502);
    }

    // Pass Google's JSON through unchanged; the client decodes it.
    return c.body(text, 200, { "Content-Type": "application/json" });
  } catch (error) {
    reqLogger.error(error, `Error proxying Routes API for user ${userSession.userId}`);
    return c.json({ success: false, message: "Failed to compute route" }, 500);
  }
}

/**
 * POST /api/client/navigation/reverse-geocode
 *
 * Proxies the Google Geocoding API for a single coordinate.
 * Body: { lat: number, lng: number }
 * Returns the Geocoding API JSON verbatim.
 */
async function reverseGeocode(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  const apiKey = process.env.GOOGLE_NAV_API_KEY;
  if (!apiKey) {
    reqLogger.error("GOOGLE_NAV_API_KEY is not set — reverse-geocode proxy unavailable");
    return c.json({ success: false, message: "Navigation service not configured" }, 503);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const { lat, lng } = body as { lat?: unknown; lng?: unknown };
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return c.json({ success: false, message: "valid lat/lng required" }, 400);
    }

    // result_type=route filters to street/route components, matching the
    // client's original direct call.
    const url = `${GEOCODING_API_URL}?latlng=${latNum},${lngNum}&result_type=route&key=${apiKey}`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      reqLogger.warn({ status: res.status }, `Geocoding API error for user ${userSession.userId}`);
      return c.json({ success: false, message: `Geocoding API ${res.status}` }, 502);
    }

    return c.body(text, 200, { "Content-Type": "application/json" });
  } catch (error) {
    reqLogger.error(error, `Error proxying Geocoding API for user ${userSession.userId}`);
    return c.json({ success: false, message: "Failed to reverse-geocode" }, 500);
  }
}

export default app;
