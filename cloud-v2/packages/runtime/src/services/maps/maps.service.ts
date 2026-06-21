/**
 * @fileoverview Runtime maps service: geocoding + directions, provider-agnostic.
 *
 * The API layer owns HTTP/validation; this service owns provider CHOICE and the
 * thin domain calls. It only ever touches the `MapsProvider` interface, so it is
 * unaware of whether Mapbox or Google is behind it — that is the whole point of
 * the abstraction.
 *
 * Provider is chosen by `MAPS_PROVIDER` (default "mapbox"), mirroring
 * `STORAGE_PROVIDER` / `STREAM_PROVIDER`. The provider is built once per process
 * and cached; `resetMapsProvider()` clears it for tests / config switches.
 *
 * Mapbox is the only provider today. The selection switch is intentionally kept
 * so adding another vendor (Google, etc.) is a one-file change: implement the
 * `MapsProvider` interface in a new `<vendor>.provider.ts`, add a `case` here,
 * and set `MAPS_PROVIDER=<vendor>`. Nothing else in the service, API, protocol,
 * or client changes.
 *
 * Caching — the real protection against accidental client render loops (the v1
 * cloud was burned by an un-cached geocoding endpoint; this restores that). Both
 * caches store the in-flight PROMISE, so concurrent identical requests share one
 * upstream call (in-flight dedup), not just sequential ones. We cache the
 * NEUTRAL result (Route[] / {road}) above the provider, so the cache is
 * provider-agnostic. Failures are never cached, so one upstream blip can't pin an
 * error. Ported from cloud/.../client/navigation.service.ts.
 *
 * See docs/issues/002-cloud-runtime/maps/spec.md.
 */
import type {
  DirectionsRequest,
  DirectionsResult,
  LatLng,
  ReverseGeocodeResult,
  Route,
} from "../../protocol/maps";
import { createMapboxProvider } from "./providers/mapbox.provider";
import type { MapsProvider } from "./providers/provider";

let provider: MapsProvider | null = null;

/** The configured maps provider (built once per process). */
export function getMapsProvider(): MapsProvider {
  if (provider) return provider;
  const kind = process.env.MAPS_PROVIDER ?? "mapbox";
  switch (kind) {
    case "mapbox":
      provider = createMapboxProvider();
      break;
    default:
      // Add a `case "<vendor>"` above (and a `<vendor>.provider.ts`) to support
      // another maps provider.
      throw new Error(`unknown MAPS_PROVIDER: ${kind}`);
  }
  return provider;
}

/** Test/boot hook: reset the cached provider (for example to switch config). */
export function resetMapsProvider(): void {
  provider = null;
}

// ---------------------------------------------------------------------------
// Promise cache (TTL + in-flight dedup, FIFO-bounded)
// ---------------------------------------------------------------------------

// Routes embed traffic-aware durations, so the cache only needs to outlive a
// render-loop burst, not a reroute cycle.
const ROUTE_CACHE_TTL_MS = 30_000;
const ROUTE_CACHE_MAX_ENTRIES = 500;

// Road names are effectively static; the mobile road-name resolver re-probes the
// same step midpoints on every route recompute, so long TTLs pay off.
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60_000;
const GEOCODE_CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

const routeCache = new Map<string, CacheEntry<Route[]>>();
const geocodeCache = new Map<string, CacheEntry<{ road: string | null }>>();

/** Test hook: drop all cached entries. */
export function clearMapsCaches(): void {
  routeCache.clear();
  geocodeCache.clear();
}

/**
 * Return the cached promise for `key`, or create one via `fn`. The promise is
 * stored BEFORE it settles, so concurrent identical calls coalesce onto one
 * upstream request (in-flight dedup). A promise that REJECTS is evicted on
 * settle, so a failure is never served from cache (and the rejection still
 * propagates to every waiter, matching `fn`'s own throw-on-failure contract).
 */
function cachedUpstream<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  maxEntries: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.promise;
  }

  const promise = fn().catch((err: unknown) => {
    // Evict on failure so one upstream blip can't pin an error for the whole
    // TTL. Guard: only drop the entry if it is still the one we created (a
    // concurrent refresh may already have replaced it). Re-throw so waiters see
    // the real error rather than a cached success.
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw err;
  });

  cache.set(key, { expiresAt: now + ttlMs, promise });

  // FIFO bound (Map preserves insertion order). At these caps and TTLs a true
  // LRU buys nothing.
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return promise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute routes for a directions request. Primary route first, alternates after. */
export async function directions(req: DirectionsRequest): Promise<DirectionsResult> {
  // Key on the normalized request. Render loops / retries resend identical
  // inputs; a stable field order keeps those hits (semantically-equal-but-
  // reordered inputs simply miss, which is safe).
  const key = JSON.stringify({
    origin: req.origin,
    stops: req.stops,
    mode: req.mode ?? null,
    avoid: req.avoid ?? null,
    alternatives: req.alternatives ?? null,
  });
  const routes = await cachedUpstream(
    routeCache,
    key,
    ROUTE_CACHE_TTL_MS,
    ROUTE_CACHE_MAX_ENTRIES,
    () => getMapsProvider().directions(req),
  );
  return { routes };
}

/** Resolve a coordinate to a road name (null when none found nearby). */
export async function reverseGeocode(coord: LatLng): Promise<ReverseGeocodeResult> {
  // ~1 m grid: step midpoints recur exactly on recompute, and probes within a
  // meter of each other are the same road by any standard.
  const key = `${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`;
  return cachedUpstream(
    geocodeCache,
    key,
    GEOCODE_CACHE_TTL_MS,
    GEOCODE_CACHE_MAX_ENTRIES,
    () => getMapsProvider().reverseGeocode(coord),
  );
}
