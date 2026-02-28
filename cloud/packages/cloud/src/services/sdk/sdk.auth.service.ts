/**
 * SDK Auth Service
 *
 * DB-backed API key validation for third-party Apps with an in-memory cache.
 * - Validates Authorization: Bearer <packageName>:<apiKey> by hashing apiKey and
 *   comparing with the stored hashedApiKey in the App collection.
 * - Uses an in-memory cache (packageName -> hashedApiKey) to avoid repeated DB hits.
 * - On cache mismatch (i.e., validation fails against cache), falls back to DB
 *   to refresh the cache before returning a final decision.
 *
 * Security notes:
 * - We never log plaintext API keys.
 * - Comparisons use a constant-time check when possible.
 *
 * Usage:
 *   const isValid = await SdkAuthService.validateApiKey(packageName, apiKey)
 */

import crypto from "crypto";
import App, { AppI } from "../../models/app.model";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "sdk.auth.service" });

type CacheEntry = {
  hashedApiKey: string;
  updatedAt: number; // epoch ms
};

const cache = new Map<string, CacheEntry>();

// Optional: simple size guard to avoid unbounded memory growth
// If exceeded, we'll evict the oldest entry.
const MAX_CACHE_ENTRIES = 1000;

/**
 * Hash an API key using SHA-256 (hex).
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Constant-time comparison for equal-length strings.
 * Returns false when lengths differ to avoid throwing in timingSafeEqual.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(a, "utf8"),
      Buffer.from(b, "utf8"),
    );
  } catch {
    // Fallback (shouldn't hit due to length guard)
    return a === b;
  }
}

/**
 * Get hashedApiKey from cache (if present).
 */
function getFromCache(packageName: string): string | undefined {
  const entry = cache.get(packageName);
  return entry?.hashedApiKey;
}

/**
 * Put hashedApiKey into cache and apply simple eviction if needed.
 */
function putInCache(packageName: string, hashedApiKey: string): void {
  cache.set(packageName, { hashedApiKey, updatedAt: Date.now() });

  if (cache.size > MAX_CACHE_ENTRIES) {
    // Evict oldest entry
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache.entries()) {
      if (entry.updatedAt < oldestTime) {
        oldestTime = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
}

/**
 * Remove a single cache entry (or clear all when packageName is not provided).
 */
export function invalidateCache(packageName?: string): void {
  if (!packageName) {
    cache.clear();
    logger.debug("SDK auth cache: cleared all entries");
    return;
  }
  cache.delete(packageName);
  logger.debug({ packageName }, "SDK auth cache: invalidated entry");
}

/**
 * Fetch the hashedApiKey for an App from the DB.
 */
async function fetchHashedKeyFromDb(
  packageName: string,
): Promise<string | undefined> {
  const app = (await App.findOne({ packageName })
    .select("packageName hashedApiKey")
    .lean()) as Pick<AppI, "packageName" | "hashedApiKey"> | null;

  if (!app) {
    logger.warn({ packageName }, "App not found while validating API key");
    return undefined;
  }
  if (!app.hashedApiKey) {
    logger.warn({ packageName }, "App has no hashedApiKey set");
    return undefined;
  }
  return app.hashedApiKey;
}

/**
 * Validate an API key for the given packageName.
 * Flow:
 * 1) Compute candidate hash from provided apiKey.
 * 2) Try cache: if match => valid.
 * 3) If mismatch or cache miss => fetch hashedApiKey from DB (refresh cache).
 * 4) Compare again with DB value => final result.
 */
export async function validateApiKey(
  packageName: string,
  apiKey: string,
): Promise<boolean> {
  if (!packageName || !apiKey) {
    logger.debug(
      { packageName, hasApiKey: !!apiKey },
      "Missing packageName or apiKey",
    );
    return false;
  }

  const candidateHash = hashApiKey(apiKey);

  // 1) Attempt cache validation
  const cachedHash = getFromCache(packageName);
  if (cachedHash) {
    if (safeEqualHex(candidateHash, cachedHash)) {
      return true;
    }
    // Cache mismatch -> fall back to DB to refresh
    logger.debug({ packageName }, "Cache mismatch, refreshing from DB");
  } else {
    logger.debug({ packageName }, "Cache miss, fetching from DB");
  }

  // 2) Fetch from DB and refresh cache
  const dbHash = await fetchHashedKeyFromDb(packageName);
  if (!dbHash) {
    // Ensure no stale cache remains for this package
    cache.delete(packageName);
    return false;
  }

  putInCache(packageName, dbHash);

  // 3) Compare with refreshed value
  const isValid = safeEqualHex(candidateHash, dbHash);
  return isValid;
}

/**
 * Warm the cache for a package (optional helper).
 * Useful when we want to avoid first-request DB lookup.
 */
export async function warmCache(packageName: string): Promise<boolean> {
  const dbHash = await fetchHashedKeyFromDb(packageName);
  if (!dbHash) {
    cache.delete(packageName);
    return false;
  }
  putInCache(packageName, dbHash);
  return true;
}

/**
 * Observe cache stats (for debugging/metrics).
 */
export function getCacheStats() {
  return {
    size: cache.size,
    max: MAX_CACHE_ENTRIES,
  };
}

export default {
  validateApiKey,
  invalidateCache,
  warmCache,
  getCacheStats,
  hashApiKey,
};
