/**
 * Rate Limiting Middleware for SimpleStorage API
 *
 * Protects MongoDB from abuse by limiting requests per user+package combination.
 * With 3s/10s SDK debouncing, this serves as a backup safety net.
 *
 * Limit: 100 requests per minute per (email, packageName) tuple
 */

import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * In-memory rate limit store
 * Key: "email:packageName"
 * Value: { count, resetTime }
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up old entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now > entry.resetTime) {
        rateLimitStore.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

/**
 * Rate limiter for SimpleStorage endpoints
 *
 * Configuration:
 * - Window: 60 seconds (1 minute)
 * - Max requests: 100 per window
 * - Keyed by: (email, packageName) from SDK auth
 */
export function simpleStorageRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  try {
    // Extract email and packageName
    const email = String(req.params.email || "").toLowerCase();
    const packageName = req.sdk?.packageName || "unknown";

    if (!email) {
      // If no email, skip rate limiting (will fail auth anyway)
      return next();
    }

    // Generate rate limit key
    const key = `${email}:${packageName}`;
    const now = Date.now();
    const windowMs = 60_000; // 1 minute
    const maxRequests = 100;

    // Get or create rate limit entry
    let entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetTime) {
      // Create new window
      entry = {
        count: 1,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(key, entry);

      // Add rate limit headers
      res.setHeader("X-RateLimit-Limit", maxRequests.toString());
      res.setHeader("X-RateLimit-Remaining", (maxRequests - 1).toString());
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(entry.resetTime / 1000).toString(),
      );

      return next();
    }

    // Increment counter
    entry.count++;

    // Check if limit exceeded
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      res.setHeader("X-RateLimit-Limit", maxRequests.toString());
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader(
        "X-RateLimit-Reset",
        Math.ceil(entry.resetTime / 1000).toString(),
      );
      res.setHeader("Retry-After", retryAfter.toString());

      return res.status(429).json({
        error: "Rate limit exceeded: 100 requests/min max for SimpleStorage",
        retryAfter,
      });
    }

    // Add rate limit headers
    res.setHeader("X-RateLimit-Limit", maxRequests.toString());
    res.setHeader(
      "X-RateLimit-Remaining",
      (maxRequests - entry.count).toString(),
    );
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil(entry.resetTime / 1000).toString(),
    );

    next();
  } catch (error) {
    // On error, allow the request through (fail open)
    console.error("Rate limit middleware error:", error);
    next();
  }
}
