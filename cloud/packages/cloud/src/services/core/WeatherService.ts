import axios from "axios";
import { logger as rootLogger } from "../logging/pino-logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WeatherSummary {
  condition: string;
  tempC: number; // canonical, rounded integer °C
  tempF: number; // derived locally, rounded integer °F
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type BucketKey = string; // "lat.toFixed(2),lng.toFixed(2)"

interface CacheEntry {
  bucketKey: BucketKey;
  lat: number;
  long: number;
  weatherSummary: WeatherSummary;
  fetchedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROXIMITY_KM = 5;
const FRESH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SHARED_CACHE_ENTRIES = 1000;

// ---------------------------------------------------------------------------
// WeatherService
// ---------------------------------------------------------------------------

/**
 * Cross-user singleton that fetches weather from the OpenWeatherMap One Call
 * API (v3) and maintains two layers of in-process cache:
 *
 *  1. **Per-user cache** (`Map<userId, CacheEntry>`) — single entry per user,
 *     invalidated when the user moves more than PROXIMITY_KM away.
 *
 *  2. **Shared geo-bucket cache** (`Map<BucketKey, CacheEntry>`) — keyed by a
 *     rounded lat/lng string (~1.1 km per 0.01° at the equator), with LRU
 *     eviction capped at MAX_SHARED_CACHE_ENTRIES.
 *
 * Because `ngeohash` is not a cloud dependency, bucket keys are computed by
 * rounding lat/lng to 2 decimal places. Neighbor-bucket boundary checks are
 * therefore omitted — the haversine proximity guard (PROXIMITY_KM) compensates
 * for the coarser bucket resolution.
 *
 * Required env var: `OPEN_WEATHER_API_KEY`
 */
export class WeatherService {
  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  private static _instance: WeatherService | null = null;

  public static instance(): WeatherService {
    if (!WeatherService._instance) {
      WeatherService._instance = new WeatherService();
    }
    return WeatherService._instance;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private readonly logger: ReturnType<typeof rootLogger.child>;
  private readonly apiKey: string | undefined = process.env.OPEN_WEATHER_API_KEY;

  /** Single-entry per-user cache: userId → CacheEntry */
  private perUserCache = new Map<string, CacheEntry>();

  /** Shared cross-user proximity cache: bucketKey → CacheEntry */
  private sharedCache = new Map<BucketKey, CacheEntry>();

  /** LRU order for shared cache — tail is most-recently-used */
  private sharedLRU: BucketKey[] = [];

  // -------------------------------------------------------------------------
  // Constructor (private — use WeatherService.instance())
  // -------------------------------------------------------------------------

  private constructor() {
    this.logger = rootLogger.child({ service: "WeatherService" });
    this.logger.info("WeatherService initialized.");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns a WeatherSummary for the given user and coordinates, or `null` on
   * error. Results are served from cache when the cached fix is still fresh
   * (< 10 min) and within PROXIMITY_KM of the requested coordinate.
   */
  public async getWeather(userId: string, lat: number, lng: number): Promise<WeatherSummary | null> {
    const currentTime = Date.now();

    // ------------------------------------------------------------------
    // 1) Per-user cache check
    // ------------------------------------------------------------------
    const userEntry = this.perUserCache.get(userId);
    if (userEntry && userEntry.expiresAt > currentTime) {
      if (this.withinKm({ lat: userEntry.lat, lon: userEntry.long }, { lat, lon: lng }, PROXIMITY_KM)) {
        this.logger.debug({ userId, bucketKey: userEntry.bucketKey }, "weather.cache.hit.user");
        return userEntry.weatherSummary;
      }
    }

    // ------------------------------------------------------------------
    // 2) Shared geo-bucket cache check
    // ------------------------------------------------------------------
    const bucketKey = this.computeBucketKey(lat, lng);
    const sharedEntry = this.sharedCache.get(bucketKey);

    if (sharedEntry && sharedEntry.expiresAt > currentTime) {
      if (this.withinKm({ lat: sharedEntry.lat, lon: sharedEntry.long }, { lat, lon: lng }, PROXIMITY_KM)) {
        this.logger.debug({ userId, bucketKey }, "weather.cache.hit.shared");
        // Hydrate per-user cache so the next call for this user is O(1).
        this.perUserCache.set(userId, sharedEntry);
        return sharedEntry.weatherSummary;
      }
    }

    // Note: neighbor-bucket checks are intentionally omitted because ngeohash
    // is not available. The haversine proximity guard (PROXIMITY_KM = 5 km)
    // is generous enough relative to the ~1.1 km bucket size that stale
    // boundary misses fall through to a cheap re-fetch within the TTL window.

    // ------------------------------------------------------------------
    // 3) Network fetch
    // ------------------------------------------------------------------
    if (!this.apiKey) {
      this.logger.error({ userId }, "OPEN_WEATHER_API_KEY is not set — cannot fetch weather.");
      return null;
    }

    const url =
      `https://api.openweathermap.org/data/3.0/onecall` +
      `?lat=${lat}&lon=${lng}&exclude=minutely,hourly,daily,alerts&units=metric&appid=${this.apiKey}`;

    this.logger.debug({ userId, lat, lng, bucketKey }, "weather.request.sent");

    try {
      const resp = await axios.get(url, { timeout: 10_000 });
      const data = resp.data;

      const condition: string = data?.current?.weather?.[0]?.main ?? "";
      const tempC: number = Math.round(data?.current?.temp ?? 0);
      const tempF: number = Math.round((tempC * 9) / 5 + 32);

      const summary: WeatherSummary = { condition, tempC, tempF };

      const entry: CacheEntry = {
        bucketKey,
        lat,
        long: lng,
        weatherSummary: summary,
        fetchedAt: currentTime,
        expiresAt: currentTime + FRESH_TTL_MS,
      };

      // Populate both cache layers.
      this.upsertSharedCache(entry);
      this.perUserCache.set(userId, entry);

      this.logger.debug({ userId, bucketKey, condition, tempC, tempF }, "weather.request.success");

      return summary;
    } catch (err: any) {
      this.logger.error({ userId, lat, lng, errorMessage: err?.message }, "weather.request.failed");
      return null;
    }
  }

  /**
   * Evicts the per-user cache entry for the given user. Useful when a user
   * session ends or when their location changes dramatically.
   */
  public clearUser(userId: string): void {
    this.perUserCache.delete(userId);
  }

  // -------------------------------------------------------------------------
  // Test helpers (prefixed with __ so they stand out)
  // -------------------------------------------------------------------------

  /** Reset all caches — intended for test isolation only. */
  public __resetForTests(): void {
    this.perUserCache.clear();
    this.sharedCache.clear();
    this.sharedLRU = [];
  }

  /** Returns the current size of the shared cache. */
  public __sharedCacheSize(): number {
    return this.sharedCache.size;
  }

  /** Returns true if the shared cache has a bucket entry for this coordinate. */
  public __hasSharedFor(lat: number, lng: number): boolean {
    return this.sharedCache.has(this.computeBucketKey(lat, lng));
  }

  // -------------------------------------------------------------------------
  // Private: shared-cache LRU management
  // -------------------------------------------------------------------------

  /**
   * Insert or update `entry` in the shared cache, bump it to the tail of the
   * LRU list, and evict the oldest entry if the cap is exceeded.
   */
  private upsertSharedCache(entry: CacheEntry): void {
    this.sharedCache.set(entry.bucketKey, entry);

    // Move/add bucket key to the tail (most-recently-used position).
    const idx = this.sharedLRU.indexOf(entry.bucketKey);
    if (idx >= 0) {
      this.sharedLRU.splice(idx, 1);
    }
    this.sharedLRU.push(entry.bucketKey);

    // Evict from the head (least-recently-used) when over capacity.
    while (this.sharedLRU.length > MAX_SHARED_CACHE_ENTRIES) {
      const evict = this.sharedLRU.shift()!;
      this.sharedCache.delete(evict);
      this.logger.debug({ evictedBucketKey: evict }, "weather.cache.shared.evicted");
    }
  }

  // -------------------------------------------------------------------------
  // Private: bucket-key and proximity helpers
  // -------------------------------------------------------------------------

  /**
   * Computes a stable string key for the ~1.1 km × ~1.1 km bucket that
   * contains (lat, lng). Each 0.01° step is roughly 1.1 km at the equator.
   *
   * ngeohash is not a cloud dependency, so we use rounded decimal strings
   * instead of a geohash. Neighbor-bucket checks are therefore omitted.
   */
  private computeBucketKey(lat: number, lon: number): BucketKey {
    return `${lat.toFixed(2)},${lon.toFixed(2)}`;
  }

  /** Returns true when the haversine distance between a and b is ≤ maxKm. */
  private withinKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }, maxKm: number): boolean {
    return this.haversineKm(a.lat, a.lon, b.lat, b.lon) <= maxKm;
  }

  /**
   * Haversine great-circle distance in kilometres.
   * Uses the numerically stable asin-sqrt formulation.
   */
  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's mean radius, km
    const toRad = (d: number) => (d * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);

    const a = sinDLat * sinDLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;

    const c = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    return R * c;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const weatherService = WeatherService.instance();
