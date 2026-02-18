// This file is used to communicate between the MongoDB database

import { AppUptime } from "../../models/app-uptime.model";
import { logger as rootLogger } from "../logging/pino-logger";
import axios from "axios";
import App from "../../models/app.model";

const logger = rootLogger.child({ service: "app-uptime.service" }); // Create a specialized logger for this service to help with debugging
const ONE_MINUTE_MS = 60000;
let uptimeScheduler: NodeJS.Timeout | null = null; // Store interval reference for cleanup

/**
 * Package names that are exempt from uptime checks.
 * These apps are always considered online/healthy for the purposes of uptime.
 */
const UPTIME_EXEMPT_PACKAGES: ReadonlySet<string> = new Set([
  "com.augmentos.livecaptions",
]);

// Pkg Health check by packageName.
export async function pkgHealthCheck(packageName: string): Promise<boolean> {
  try {
    // Exempted apps are always considered healthy
    if (UPTIME_EXEMPT_PACKAGES.has(packageName)) {
      logger.debug({ packageName }, "Skipping health check for exempt package");
      return true;
    }

    const app = await App.findOne({ packageName }).lean();
    if (!app || !app.publicUrl) {
      logger.warn(
        `App with packageName ${packageName} not found or has no publicUrl`,
      );
      return false;
    }

    const response = await axios.get(`${app.publicUrl}/health`, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });
    return response.status === 200;
  } catch (error) {
    logger.error(error as Error, `Error checking health for ${packageName}:`);
    return false;
  }
}

//return their current health status.
export async function fetchSubmittedAppHealthStatus() {
  console.log("🔍 Fetching submitted apps with health status...");
  // Include both SUBMITTED and PUBLISHED apps so the store can consume status too
  const appsData = await App.find({
    appStoreStatus: { $in: ["SUBMITTED", "PUBLISHED"] },
  }).lean();

  // Check health status for each app by calling their /health endpoint
  const appsWithHealthStatus = [];

  for (const app of appsData) {
    let healthStatus = "offline";
    let healthData = null;

    // If app is exempt from uptime checks, force it online without ping
    if (UPTIME_EXEMPT_PACKAGES.has(app.packageName)) {
      healthStatus = "online";
      healthData = { status: "healthy", exemptedFromUptimeChecks: true };
      console.log(
        `🟢 ${app.packageName} is exempt from uptime checks - marking as online`,
      );
    } else if (app.publicUrl) {
      try {
        console.log(
          `🏥 Checking health for ${app.packageName} at ${app.publicUrl}/health`,
        );
        const response = await axios.get(`${app.publicUrl}/health`, {
          timeout: 10000,
          headers: { "Content-Type": "application/json" },
        });

        if (response.status === 200 && response.data) {
          healthData = response.data;
          console.log(
            `📋 Health response for ${app.packageName}:`,
            JSON.stringify(healthData, null, 2),
          );

          // Check if response matches expected format {"status":"healthy","app":"...","activeSessions":...}
          if (healthData.status === "healthy") {
            healthStatus = "online";
            console.log(`✅ ${app.packageName} is healthy - marking as online`);
          } else {
            healthStatus = "offline";
            console.log(
              `❌ ${app.packageName} status is ${healthData.status} - marking as offline`,
            );
          }
        } else {
          console.log(
            `⚠️ ${app.packageName} returned status ${response.status} - marking as offline`,
          );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          if (error.code === "ECONNABORTED") {
            console.log(
              `⏰ ${app.packageName} health check timed out - marking as offline`,
            );
          } else {
            console.log(
              `🔴 ${app.packageName} health check failed: ${error.message} - marking as offline`,
            );
          }
        } else {
          console.log(
            `❌ ${app.packageName} unknown error: ${error} - marking as offline`,
          );
        }
      }
    } else {
      console.log(
        `⚠️ ${app.packageName} has no publicUrl - marking as offline`,
      );
    }

    // Add app with health status
    appsWithHealthStatus.push({
      packageName: app.packageName,
      publicUrl: app.publicUrl,
      name: app.name,
      _id: app._id,
      appStoreStatus: app.appStoreStatus,
      updatedAt: app.updatedAt,
      logoURL: app.logoURL,
      description: app.description,
      healthStatus: healthStatus,
      healthData: healthData,
    });
  }

  // console.log('🎯 Apps with health status:', JSON.stringify(appsWithHealthStatus, null, 2));

  return {
    success: true,
    count: appsData.length,
    apps: appsWithHealthStatus,
  };
}

// Collects health data for all submitted apps, transforms it into uptime records, and batch inserts those records into the database.
export async function sendBatchUptimeData(): Promise<void> {
  logger.debug("Starting batch uptime data collection...");

  try {
    // Get all submitted apps with their health status
    const healthResult = await fetchSubmittedAppHealthStatus();

    if (!healthResult.success || !healthResult.apps) {
      logger.warn("No apps found or failed to fetch app health status");
      return;
    }

    const batchData: any[] = [];
    const timestamp = new Date();

    // Process each app and prepare batch data
    for (const app of healthResult.apps) {
      let health: "healthy" | "degraded" | "offline" = "offline";
      let responseTimeMs: number | null = null;
      let onlineStatus = false;

      // Determine health status based on healthStatus field
      if (app.healthStatus === "online") {
        health = "healthy";
        onlineStatus = true;

        // Extract response time if available in healthData
        if (app.healthData && typeof app.healthData === "object") {
          responseTimeMs = app.healthData.responseTime || null;
        }
      } else {
        health = "offline";
        onlineStatus = false;
      }

      const uptimeRecord = {
        packageName: app.packageName,
        timestamp,
        health,
        onlineStatus,
        responseTimeMs,
      };

      batchData.push(uptimeRecord);

      // Notify developers if a published app is offline (at most once per 24h)
      try {
        if (app.appStoreStatus === "PUBLISHED" && !onlineStatus) {
          await maybeNotifyDevelopers(app.packageName);
        }
      } catch (e) {
        logger.warn(
          { e, packageName: app.packageName },
          "notifyDevelopers failed",
        );
      }
    }

    // Batch insert all uptime records
    if (batchData.length > 0) {
      await AppUptime.insertMany(batchData);
      logger.debug(
        `Successfully saved ${batchData.length} uptime records to database`,
      );
    } else {
      logger.warn("No uptime data to save");
    }
  } catch (error) {
    logger.error(error, "Error in batch uptime data collection:");
    throw error;
  }
}

/**
 * Returns the latest known onlineStatus and health for a list of packages.
 * Uses AppUptime collection to avoid live pings.
 */
export async function getLatestStatusesForPackages(
  packageNames: string[],
): Promise<
  Array<{
    packageName: string;
    onlineStatus: boolean;
    health: string;
    timestamp: Date;
  }>
> {
  if (!packageNames || packageNames.length === 0) return [];

  const agg = await AppUptime.aggregate([
    { $match: { packageName: { $in: packageNames } } },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: "$packageName",
        packageName: { $first: "$packageName" },
        onlineStatus: { $first: "$onlineStatus" },
        health: { $first: "$health" },
        timestamp: { $first: "$timestamp" },
      },
    },
  ]);

  return agg as Array<{
    packageName: string;
    onlineStatus: boolean;
    health: string;
    timestamp: Date;
  }>;
}

/**
 * Notify app developer/organization if a published app is offline.
 * Sends at most one email every 24 hours per app.
 */
async function maybeNotifyDevelopers(packageName: string): Promise<void> {
  try {
    const appDoc: any = await App.findOne({ packageName });
    if (!appDoc) return;

    const now = new Date();
    const lastEmailAt: Date | undefined = (appDoc as any).lastOutageEmailAt;
    if (lastEmailAt) {
      const elapsedMs = now.getTime() - new Date(lastEmailAt).getTime();
      if (elapsedMs < 24 * 60 * 60 * 1000) {
        // Skip if emailed within last 24 hours
        return;
      }
    }

    // Determine recipient: prefer organization profile contactEmail; fallback to developerId (email)
    let recipientEmail: string | null = null;
    try {
      if (appDoc.organizationId) {
        const Organization =
          require("../../models/organization.model").Organization;
        const org = await Organization.findById(appDoc.organizationId);
        recipientEmail = org?.profile?.contactEmail || null;
      }
    } catch (e) {
      logger.warn(
        { e, packageName },
        "Error loading organization for outage email",
      );
    }
    if (!recipientEmail && appDoc.developerId) {
      recipientEmail = appDoc.developerId;
    }

    if (!recipientEmail) return;

    // Send email via Resend service helper (behind env flag)
    try {
      const shouldSend = process.env.AUTO_SEND_DOWNTIME_EMAILS === "true";
      if (!shouldSend) {
        logger.info(
          {
            packageName,
            recipientEmail,
          },
          "AUTO_SEND_DOWNTIME_EMAILS disabled; would send outage email but logging only",
        );
      } else {
        const { emailService } = require("../email/resend.service");
        const result = await emailService.sendAppOutageNotification(
          recipientEmail,
          appDoc.name,
          packageName,
          appDoc.publicUrl,
        );
        if (!(result && !result.error)) {
          logger.warn(
            { packageName, recipientEmail, result },
            "Outage email send returned error",
          );
        } else {
          (appDoc as any).lastOutageEmailAt = now;
          await appDoc.save();
        }
      }
    } catch (e) {
      logger.warn(
        { e, packageName },
        "Failed to process outage email notification",
      );
    }
  } catch (error) {
    logger.warn(
      { error, packageName },
      "maybeNotifyDevelopers encountered error",
    );
  }
}

// Starts a recurring scheduler that runs sendBatchUptimeData every minute, ensuring only one scheduler is active by clearing any existing one first.
export function startUptimeScheduler(): void {
  // Clear existing scheduler if running
  if (uptimeScheduler) {
    clearInterval(uptimeScheduler);
  }

  logger.debug("Starting uptime scheduler - will run every minute");

  // Run immediately on start
  sendBatchUptimeData().catch((error) => {
    logger.error(error, "Initial batch uptime collection failed:");
  });

  // Schedule to run every minute (60000 ms)
  uptimeScheduler = setInterval(async () => {
    try {
      await sendBatchUptimeData();
    } catch (error) {
      logger.error(error, "Scheduled batch uptime collection failed:");
    }
  }, ONE_MINUTE_MS);
}

// Fetches all app uptime records for a specified month and year by parsing the input, generating a date range, and querying the database within that range.
export async function collectAllAppBatchStatus(month: string, year: number) {
  try {
    logger.debug(
      `Collecting app batch status for month: ${month}, year: ${year}`,
    );

    let monthNumber: number;

    // Parse month - support numbers (1-12) or month names
    if (!isNaN(Number(month))) {
      // It's a number (1-12)
      monthNumber = parseInt(month);
      if (monthNumber < 1 || monthNumber > 12) {
        throw new Error(`Month number must be between 1-12, got: ${month}`);
      }
    } else {
      // Month name
      const monthLower = month.toLowerCase();
      const monthNames = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ];

      if (monthNames.includes(monthLower)) {
        monthNumber = monthNames.indexOf(monthLower) + 1;
      } else {
        throw new Error(
          `Invalid month format: ${month}. Use number (1-12) or month name.`,
        );
      }
    }

    // Create date range for the month
    const startDate = new Date(year, monthNumber - 1, 1);
    const endDate = new Date(year, monthNumber, 0, 23, 59, 59, 999);

    const allUptimeData = await AppUptime.find({
      timestamp: {
        $gte: startDate,
        $lte: endDate,
      },
    }).lean();

    logger.debug(
      `Found ${allUptimeData.length} uptime records for month ${monthNumber}/${year}`,
    );

    return {
      success: true,
      count: allUptimeData.length,
      month: month,
      monthNumber: monthNumber,
      year: year,
      dateRange: { start: startDate, end: endDate },
      data: allUptimeData,
    };
  } catch (error) {
    logger.error(error, "Error collecting all app batch status:");
    throw error;
  }
}

// Stops the uptime scheduler if it is running, clearing the interval and setting the reference to null.
export function stopUptimeScheduler(): void {
  if (uptimeScheduler) {
    clearInterval(uptimeScheduler);
    uptimeScheduler = null;
    logger.debug("Uptime scheduler stopped");
  }
}
