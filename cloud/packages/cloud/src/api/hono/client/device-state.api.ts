/**
 * @fileoverview Hono device-state API routes.
 * API endpoint for device connection state updates from mobile clients.
 * Mounted at: /api/client/device/state
 */

import { Hono } from "hono";
import { GlassesInfo } from "@mentra/types";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { incrementDeviceStateRateLimited } from "../../../services/metrics/device-state-counters";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "device-state.api" });

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Per-session rate limit (issue 099).
//
// Mobile sends POST /api/client/device/state on every Zustand field change
// with no client-side debounce. Production measurements on 2026-04-17 showed
// one user emitting 30.7 updates/minute sustained and another emitting the
// same {"modelName":"G1"} payload 13 times in 3 seconds.
//
// This middleware caps each user at RATE_LIMIT_MAX_PER_SEC requests per
// RATE_LIMIT_WINDOW_MS and returns HTTP 429 for the excess. Sessions are
// pod-sticky so per-user in-memory state is sufficient. See
// cloud/issues/099-glasses-connection-state-storm/spec.md.
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_PER_SEC = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_WARN_THROTTLE_MS = 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const RATE_LIMIT_ENTRY_MAX_AGE_MS = 5 * 60_000;

type RateLimitEntry = { count: number; windowStart: number; lastWarnAt: number };
const rateLimitState = new Map<string, RateLimitEntry>();

// Background sweep so idle users' counters don't pin memory. unref() so the
// interval doesn't block shutdown.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_ENTRY_MAX_AGE_MS;
  for (const [userId, entry] of rateLimitState) {
    if (entry.windowStart < cutoff) {
      rateLimitState.delete(userId);
    }
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();

async function rateLimit(c: AppContext, next: () => Promise<void>) {
  const userSession = c.get("userSession")!;
  const userId = userSession.userId;
  const now = Date.now();

  const existing = rateLimitState.get(userId);
  if (!existing || now - existing.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(userId, {
      count: 1,
      windowStart: now,
      lastWarnAt: existing?.lastWarnAt ?? 0,
    });
    await next();
    return;
  }

  existing.count += 1;
  if (existing.count > RATE_LIMIT_MAX_PER_SEC) {
    incrementDeviceStateRateLimited();
    if (now - existing.lastWarnAt > RATE_LIMIT_WARN_THROTTLE_MS) {
      existing.lastWarnAt = now;
      logger.warn(
        {
          userId,
          feature: "device-state",
          count: existing.count,
          windowMs: RATE_LIMIT_WINDOW_MS,
          limit: RATE_LIMIT_MAX_PER_SEC,
        },
        "Rate-limited /api/client/device/state — client is sending too many updates",
      );
    }
    c.header("Retry-After", "1");
    return c.json({ error: "Too Many Requests" }, 429);
  }

  await next();
}

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, rateLimit, updateDeviceState);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/device/state
 * Update device connection state.
 * Accepts partial updates - only specified properties are changed.
 * Body: Partial<GlassesInfo>
 */
async function updateDeviceState(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const deviceStateUpdate = (await c.req.json().catch(() => ({}))) as Partial<GlassesInfo>;

    reqLogger.debug({ feature: "device-state", deviceStateUpdate, function: "updateDeviceState" }, "updateDeviceState");

    // No validation needed - DeviceManager will infer connected state from modelName

    // Update device state via DeviceManager
    await userSession.deviceManager.updateDeviceState(deviceStateUpdate);

    // Return confirmation with current state
    return c.json({
      success: true,
      appliedState: {
        isGlassesConnected: userSession.deviceManager.isGlassesConnected,
        isPhoneConnected: userSession.deviceManager.isPhoneConnected,
        modelName: userSession.deviceManager.getModel(),
        capabilities: userSession.deviceManager.getCapabilities(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error({ error, feature: "device-state", userId: userSession.userId }, "Failed to update device state");
    return c.json(
      {
        success: false,
        message: "Failed to update device state",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
