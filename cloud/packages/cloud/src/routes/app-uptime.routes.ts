// Express Routes for App Uptime API Endpoints
// This file defines web endpoints that external systems can call to manage app uptime tracking

// Import Express framework components for handling HTTP requests
import { Router, Request, Response } from "express";
import { logger } from "../services/logging/pino-logger";
import * as AppUptimeService from "../services/core/app-uptime.service";
import axios from "axios";
import { fetchSubmittedAppHealthStatus } from "../services/core/app-uptime.service";
const router = Router();

// Start the uptime scheduler when the routes are loaded
// AppUptimeService.startUptimeScheduler();
logger.info("🔄 App uptime monitoring scheduler started automatically");

// Endpoint to ping an app's health status
export async function appPkgHealthCheck(req: Request, res: Response) {
  const { packageName } = req.body;
  if (!packageName) return res.status(400).send("Missing packageName");

  try {
    const isHealthy = await AppUptimeService.pkgHealthCheck(packageName);
    res.json({
      packageName,
      success: isHealthy,
      status: isHealthy ? 200 : 500,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error(
      err as Error,
      `Error in appPkgHealthCheck for ${packageName}:`,
    );
    res.json({
      packageName,
      success: false,
      status: 500,
      error: "Health check failed",
      timestamp: new Date(),
    });
  }
}

// Endpoint to ping an app's health status
async function pingAppHealth(req: Request, res: Response) {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    // If it's a health endpoint, return the actual health data
    if (url.includes("/health")) {
      res.json({
        status: response.status,
        success: response.status === 200,
        data: response.data,
      });
    } else {
      res.json({
        status: response.status,
        success: response.status === 200,
      });
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      res.json({
        status: err.response?.status || 500,
        success: false,
        error: err.code === "ECONNABORTED" ? "Timeout" : "Failed to reach URL",
      });
    } else {
      res.json({
        status: 500,
        success: false,
        error: "Unknown error",
      });
    }
  }
}

// Endpoint to get the status of all apps
async function appsStatus(req: Request, res: Response) {
  try {
    const healthStatus = await fetchSubmittedAppHealthStatus();
    res.json({
      timestamp: new Date(),
      status: "active",
      ...healthStatus,
    });
  } catch (error) {
    logger.error(error as Error, "Error fetching app status:");
    res.status(500).json({
      error: true,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
      timestamp: new Date(),
    });
  }
}

// Endpoint to get latest statuses for a set of packages (no live ping)
async function latestStatus(req: Request, res: Response) {
  try {
    const packagesParam = (req.query.packages as string) || "";
    const packageNames = packagesParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const result =
      await AppUptimeService.getLatestStatusesForPackages(packageNames);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error(error as Error, "Error fetching latest statuses:");
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch latest statuses" });
  }
}

// Endpoint to get app uptime days for a specific month and year
async function getAppUptimeDays(req: Request, res: Response) {
  const month = req.query.month as string;
  const year = parseInt(req.query.year as string);

  try {
    const result = await AppUptimeService.collectAllAppBatchStatus(month, year);
    res.json(result);
  } catch (error) {
    logger.error(error as Error, "Error fetching app uptime days:");
    res.status(500).json({
      error: true,
      message:
        error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
}

// Health check endpoint for the service itself
async function healthCheck(req: Request, res: Response) {
  try {
    res.json({
      status: "healthy",
      service: "app-uptime-service",
      timestamp: new Date(),
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error(error as Error, "Health check failed:");
    res.status(500).json({
      status: "unhealthy",
      service: "app-uptime-service",
      error: "Health check failed",
      timestamp: new Date(),
    });
  }
}

// Api Endpoints

// Endpoint to ping an app's health status
router.get("/ping", pingAppHealth);

// Health check for the service
router.get("/health-check", healthCheck);

// Endpoint to check health of a specific app package
router.post("/app-pkg-health-check", appPkgHealthCheck);

// Endpoint to get the status of all apps
router.get("/status", appsStatus);
router.get("/latest-status", latestStatus);

// Endpoint to get app uptime days for a specific month and year
router.get("/get-app-uptime-days", getAppUptimeDays);

export default router;
