/**
 * @fileoverview Navigation proxy business logic (Google Routes + Geocoding).
 *
 * Pure functions behind /api/client/navigation — the Hono handlers in
 * navigation.api.ts only validate input and map these results to HTTP.
 * Keeping the upstream calls here (with an injectable fetch/clock) means the
 * caching behavior is unit-testable without mocking a REST request.
 *
 * Caching — the real protection against accidental client render loops
 * (we have been burned by an un-cached geocoding endpoint before):
 *   - Both caches store the in-flight PROMISE, so 100 concurrent identical
 *     requests share one upstream call (in-flight dedup), not just 100
 *     sequential ones.
 *   - Route results are cached briefly (traffic-aware durations go stale),
 *     keyed on the exact request body — render loops and retries resend
 *     byte-identical bodies, which is the case we're absorbing.
 *   - Reverse-geocode results are cached for a long time (road names don't
 *     change), keyed on the coordinate rounded to ~1 m.
 *   - Failures are never cached, so one upstream blip can't pin an error.
 */

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

// Routes responses embed traffic-aware durations, so the cache only needs to
// outlive a render-loop burst, not a reroute cycle.
export const ROUTE_CACHE_TTL_MS = 30_000;
const ROUTE_CACHE_MAX_ENTRIES = 500;

// Road names are effectively static; the mobile road-name resolver re-probes
// the same step midpoints on every route recompute, so long TTLs pay off.
export const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60_000;
const GEOCODE_CACHE_MAX_ENTRIES = 5_000;

/**
 * Result of one proxied upstream call. `ok` carries Google's JSON verbatim
 * (the client decodes it); `upstream_error` carries Google's error body for
 * logging. Functions never reject — network failures come back as `error` so
 * a thrown promise can't get stuck in the cache.
 */
export type NavProxyResult =
  | { kind: "ok"; body: string }
  | { kind: "upstream_error"; status: number; body: string }
  | { kind: "not_configured" }
  | { kind: "error"; error: unknown };

/** Narrow fetch signature so tests can stub with a plain async function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Injectable seams for tests; production callers omit. */
export interface NavProxyDeps {
  fetchFn?: FetchLike;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Promise cache (TTL + in-flight dedup, FIFO-bounded)
// ---------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number;
  promise: Promise<NavProxyResult>;
}

const routeCache = new Map<string, CacheEntry>();
const geocodeCache = new Map<string, CacheEntry>();

/** Test hook: drop all cached entries. */
export function clearNavigationProxyCaches(): void {
  routeCache.clear();
  geocodeCache.clear();
}

/**
 * Return the cached promise for `key` or create one via `fn`. The promise is
 * stored BEFORE it settles, so concurrent identical calls coalesce onto one
 * upstream request. Entries that settle to anything but `ok` are evicted
 * immediately so failures aren't served from cache.
 */
function cachedUpstream(
  cache: Map<string, CacheEntry>,
  key: string,
  ttlMs: number,
  maxEntries: number,
  now: () => number,
  fn: () => Promise<NavProxyResult>,
): Promise<NavProxyResult> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now()) {
    return existing.promise;
  }

  const promise = fn().then((result) => {
    // Only evict if this entry is still the one we created — a concurrent
    // refresh may have replaced it.
    if (result.kind !== "ok" && cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    return result;
  });

  cache.set(key, { expiresAt: now() + ttlMs, promise });

  // FIFO bound (Map preserves insertion order). At these caps and TTLs a
  // true LRU buys nothing.
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return promise;
}

async function callUpstream(fetchFn: FetchLike, url: string, init?: RequestInit): Promise<NavProxyResult> {
  try {
    const res = await fetchFn(url, init);
    const body = await res.text();
    if (!res.ok) {
      return { kind: "upstream_error", status: res.status, body };
    }
    return { kind: "ok", body };
  } catch (error) {
    return { kind: "error", error };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Proxy a Routes API computeRoutes request. `body` is the Routes API request
 * body the client built; the response JSON is returned verbatim.
 */
export function computeRoute(body: Record<string, unknown>, deps: NavProxyDeps = {}): Promise<NavProxyResult> {
  const apiKey = process.env.GOOGLE_NAV_API_KEY;
  if (!apiKey) {
    return Promise.resolve({ kind: "not_configured" });
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;

  // Key on the serialized body. The client builds bodies deterministically,
  // and the abuse case (render loop / retry storm) resends byte-identical
  // payloads — semantically-equal-but-reordered bodies just miss the cache.
  const key = JSON.stringify(body);

  return cachedUpstream(routeCache, key, ROUTE_CACHE_TTL_MS, ROUTE_CACHE_MAX_ENTRIES, now, () =>
    callUpstream(fetchFn, ROUTES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Proxy a Geocoding API reverse-geocode for one coordinate. Callers must
 * pass finite numbers (the handler validates). result_type=route matches the
 * client's original direct call.
 */
export function reverseGeocode(lat: number, lng: number, deps: NavProxyDeps = {}): Promise<NavProxyResult> {
  const apiKey = process.env.GOOGLE_NAV_API_KEY;
  if (!apiKey) {
    return Promise.resolve({ kind: "not_configured" });
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;

  // ~1 m grid: step midpoints recur exactly on recompute, and probes within
  // a meter of each other are the same road by any standard.
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;

  const url = `${GEOCODING_API_URL}?latlng=${lat},${lng}&result_type=route&key=${apiKey}`;
  return cachedUpstream(geocodeCache, key, GEOCODE_CACHE_TTL_MS, GEOCODE_CACHE_MAX_ENTRIES, now, () =>
    callUpstream(fetchFn, url),
  );
}
