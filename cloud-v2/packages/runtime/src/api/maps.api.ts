/**
 * @fileoverview Maps service REST routes (Hono). Mounted at `/api/maps`.
 *
 * Thin HTTP over maps.service (which owns provider choice). Both endpoints are
 * plain client-initiated request/response — no WebSocket push — so the cloud
 * holds the provider token and the (miniapp) caller never sees it.
 *
 *   POST /api/maps/directions          -> { routes }
 *   POST /api/maps/reverse-geocode     -> { road, address }
 *   POST /api/maps/place-autocomplete  -> { suggestions }
 *   POST /api/maps/place-details       -> { placeId, name, address, lat, lng }
 *
 * Authenticated with the same per-user Bearer runtime token as the rest of the
 * runtime REST surface.
 *
 * Unlike camera.api (which lets service errors bubble to Hono's default handler),
 * these routes wrap the provider call and return 502: a maps request is a direct
 * synchronous call to a third-party HTTP API (Mapbox), so an upstream failure is
 * a genuine bad-gateway condition worth signalling distinctly, rather than a
 * delegation to internal storage that is not expected to throw.
 *
 * No per-user rate limiting here: cloud-v2 defers throttling to the gateway/edge
 * (no runtime endpoint limits requests today). NOTE — maps fans out to a
 * per-request-billed provider, so this is the first endpoint that will want a
 * per-user quota once gateway limits land.
 */
import { Hono, type Context } from "hono";
import {
  AccessTokenError,
  createLogger,
  verifyRuntimeToken,
} from "@mentra/cloud-shared";
import {
  directionsRequestSchema,
  placeAutocompleteRequestSchema,
  placeDetailsRequestSchema,
  reverseGeocodeRequestSchema,
} from "@mentra/cloud-protocol/maps";
import * as maps from "../services/maps/maps.service";

const logger = createLogger("maps").child({ service: "maps.api" });

export const mapsApi = new Hono();

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

mapsApi.post("/directions", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = directionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid directions request", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await maps.directions(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    logger.error({ message: err instanceof Error ? err.message : String(err) }, "directions failed");
    return c.json({ error: "directions failed" }, 502);
  }
});

mapsApi.post("/reverse-geocode", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = reverseGeocodeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid reverse-geocode request", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await maps.reverseGeocode(parsed.data);
    return c.json(result, 200);
  } catch (err) {
    logger.error({ message: err instanceof Error ? err.message : String(err) }, "reverse geocode failed");
    return c.json({ error: "reverse geocode failed" }, 502);
  }
});

mapsApi.post("/place-autocomplete", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = placeAutocompleteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid place-autocomplete request", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await maps.placeAutocomplete(
      parsed.data.query,
      parsed.data.near,
      parsed.data.sessionToken,
    );
    return c.json(result, 200);
  } catch (err) {
    logger.error({ message: err instanceof Error ? err.message : String(err) }, "place autocomplete failed");
    return c.json({ error: "place autocomplete failed" }, 502);
  }
});

mapsApi.post("/place-details", async (c) => {
  const auth = await authUser(c);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = placeDetailsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid place-details request", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await maps.placeDetails(parsed.data.placeId, parsed.data.sessionToken);
    return c.json(result, 200);
  } catch (err) {
    logger.error({ message: err instanceof Error ? err.message : String(err) }, "place details failed");
    return c.json({ error: "place details failed" }, 502);
  }
});
