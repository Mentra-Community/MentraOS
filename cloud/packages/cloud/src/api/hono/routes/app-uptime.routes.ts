/**
 * @fileoverview Hono app-uptime routes.
 * App health monitoring and uptime tracking endpoints.
 * Mounted at: /api/app-uptime
 */

import { Hono } from "hono";
import axios from "axios";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import * as AppUptimeService from "../../../services/core/app-uptime.service";
import { fetchSubmittedAppHealthStatus } from "../../../services/core/app-uptime.service";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "app-uptime.routes" });

const app = new Hono<AppEnv>();

// Log that the uptime monitoring is available
logger.info("🔄 App uptime monitoring routes loaded");

// ============================================================================
// Routes
// ============================================================================

app.get("/ping", pingAppHealth);
app.get("/health-check", healthCheck);
app.post("/app-pkg-health-check", appPkgHealthCheck);
app.get("/status", appsStatus);
app.get("/latest-status", latestStatus);
app.get("/get-app-uptime-days", getAppUptimeDays);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/app-uptime/ping
 * Ping an app's health status by URL.
 * Query params: url
 */
async function pingAppHealth(c: AppContext) {
  const url = c.req.query("url");

  if (!url) {
    return c.json({ error: "Missing URL" }, 400);
  }

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    // If it's a health endpoint, return the actual health data
    if (url.includes("/health")) {
      return c.json({
        status: response.status,
        success: response.status === 200,
        data: response.data,
      });
    } else {
      return c.json({
        status: response.status,
        success: response.status === 200,
      });
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      return c.json({
        status: err.response?.status || 500,
        success: false,
        error: err.code === "ECONNABORTED" ? "Timeout" : "Failed to reach URL",
      });
    } else {
      return c.json({
        status: 500,
        success: false,
        error: "Unknown error",
      });
    }
  }
}

/**
 * GET /api/app-uptime/health-check
 * Health check endpoint for the app-uptime service itself.
 */
async function healthCheck(c: AppContext) {
  try {
    return c.json({
      status: "healthy",
      service: "app-uptime-service",
      timestamp: new Date(),
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error(error, "Health check failed:");
    return c.json(
      {
        status: "unhealthy",
        service: "app-uptime-service",
        error: "Health check failed",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * POST /api/app-uptime/app-pkg-health-check
 * Check the health of a specific app package.
 * Body: { packageName: string }
 */
async function appPkgHealthCheck(c: AppContext) {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { packageName } = body as { packageName?: string };

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const isHealthy = await AppUptimeService.pkgHealthCheck(packageName);

    return c.json({
      packageName,
      success: isHealthy,
      status: isHealthy ? 200 : 500,
      timestamp: new Date(),
    });
  } catch (err) {
    const packageName = (await c.req.json().catch(() => ({}))).packageName || "unknown";
    logger.error(err, `Error in appPkgHealthCheck for ${packageName}:`);
    return c.json({
      packageName,
      success: false,
      status: 500,
      error: "Health check failed",
      timestamp: new Date(),
    });
  }
}

/**
 * GET /api/app-uptime/status
 * Get the health status of all submitted apps.
 */
async function appsStatus(c: AppContext) {
  try {
    const healthStatus = await fetchSubmittedAppHealthStatus();
    return c.json({
      timestamp: new Date(),
      status: "active",
      ...healthStatus,
    });
  } catch (error) {
    logger.error(error, "Error fetching app status:");
    return c.json(
      {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error occurred",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * GET /api/app-uptime/latest-status
 * Get latest statuses for a set of packages (no live ping).
 * Query params: packages (comma-separated list)
 */
async function latestStatus(c: AppContext) {
  try {
    const packagesParam = c.req.query("packages") || "";
    const packageNames = packagesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const result = await AppUptimeService.getLatestStatusesForPackages(packageNames);

    return c.json({ success: true, data: result });
  } catch (error) {
    logger.error(error, "Error fetching latest statuses:");
    return c.json({ success: false, message: "Failed to fetch latest statuses" }, 500);
  }
}

/**
 * GET /api/app-uptime/get-app-uptime-days
 * Get app uptime days for a specific month and year.
 * Query params: month, year
 */
async function getAppUptimeDays(c: AppContext) {
  const month = c.req.query("month");
  const yearStr = c.req.query("year");

  if (!month || !yearStr) {
    return c.json({ error: "Missing month or year parameter" }, 400);
  }

  const year = parseInt(yearStr, 10);

  if (isNaN(year)) {
    return c.json({ error: "Invalid year parameter" }, 400);
  }

  try {
    const result = await AppUptimeService.collectAllAppBatchStatus(month, year);
    return c.json(result);
  } catch (error) {
    logger.error(error, "Error fetching app uptime days:");
    return c.json(
      {
        error: true,
        message: error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
}

export default app;
