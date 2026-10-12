/**
 * @fileoverview Fixed-window rate limits for Core's portal sign-in routes.
 *
 * Counters live in Mongo (`auth_rate_limits`), so every Core instance shares
 * them. One atomic upsert-and-increment per call: exactly `limit` calls in a
 * window succeed, however many arrive at once.
 */

import {AuthRateLimitModel} from "../../models/auth-rate-limit.model"

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as {code?: number}).code === 11000
}

/** Count one call against `key`; true while the window's count is within `limit`. */
export async function consumeRateLimit(key: string, limit: number, windowSec: number, now = Date.now()): Promise<boolean> {
  const windowMs = windowSec * 1000
  const windowStart = Math.floor(now / windowMs) * windowMs
  const id = `${key}:${windowStart}`
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await AuthRateLimitModel.findOneAndUpdate(
        {_id: id},
        {$inc: {count: 1}, $setOnInsert: {windowEndsAt: new Date(windowStart + windowMs)}},
        {upsert: true, new: true},
      ).lean()
      return (row?.count ?? Number.POSITIVE_INFINITY) <= limit
    } catch (err) {
      // Two first calls in a window can race the upsert; the loser retries as an update.
      if (attempt === 0 && isDuplicateKeyError(err)) continue
      throw err
    }
  }
}
