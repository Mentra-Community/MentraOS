/**
 * @fileoverview Rate limiting for the account endpoints (issue 019 spec.md:
 * "Every account endpoint is rate limited per IP and per email... guarantees
 * 429 with `rate_limited`").
 *
 * Fixed-window, in-memory. Core runs a single replica in every environment
 * today (see porter.*.yaml `instances: 1`), so per-pod counting IS the global
 * count. If core ever scales out, limits become per-pod (N x looser) — move
 * the buckets to Redis before doing that.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.types";
import { AccountError } from "../../services/account/account-error";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Reset all counters. Test-only — mirrors resetSigningKeyCache. */
export function resetAccountRateLimits(): void {
  buckets.clear();
}

function hit(key: string, limit: number, windowSec: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

// Opportunistic prune so long-lived processes don't accumulate dead buckets.
let lastPrune = 0;
function maybePrune(): void {
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

function clientIp(header: string | undefined): string {
  // Behind the cluster ingress the first x-forwarded-for hop is the client.
  return header?.split(",")[0]?.trim() || "unknown";
}

/**
 * Per-IP (always) and per-email (when the JSON body carries one) fixed-window
 * limits. Emits the spec's `rate_limited` error code as HTTP 429.
 *
 * Reading the body here is safe: Hono caches the parsed body, so the handler's
 * own `c.req.json()` still works.
 */
export function accountRateLimit(opts: {
  scope: string;
  limit: number;
  windowSec: number;
  perEmail?: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    maybePrune();
    const ip = clientIp(c.req.header("x-forwarded-for"));
    if (!hit(`${opts.scope}:ip:${ip}`, opts.limit, opts.windowSec)) {
      throw new AccountError("rate_limited", "too many attempts, try again later", 429);
    }
    if (opts.perEmail) {
      let email = "";
      try {
        const body = (await c.req.json()) as Record<string, unknown>;
        const raw = body?.email ?? body?.newEmail;
        if (typeof raw === "string") email = raw.trim().toLowerCase();
      } catch {
        // No JSON body; the handler will reject it — nothing to key on here.
      }
      if (email && !hit(`${opts.scope}:email:${email}`, opts.limit, opts.windowSec)) {
        throw new AccountError("rate_limited", "too many attempts, try again later", 429);
      }
    }
    await next();
  };
}
