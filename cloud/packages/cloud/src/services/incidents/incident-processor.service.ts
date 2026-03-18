// services/incidents/incident-processor.service.ts
// Background job for processing incidents: fetching cloud logs, LLM analysis, Linear ticket creation

import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../logging/pino-logger";
import { queryBetterStackLogs } from "../logging/betterstack-query.service";
import { incidentStorage } from "../storage/incident-storage.service";
import { Incident } from "../../models/incident.model";
import { slackService } from "../notifications/slack.service";
import { emailService } from "../email/resend.service";
import { generateBugSummary, createOrUpdateLinearIssue, type BugSummary } from "../integrations/linear.service";
import { UserSession } from "../session/UserSession";
import { CloudToAppMessageType } from "@mentra/sdk";

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Upload token expiry (5 minutes - enough time for apps to gather and upload logs)
const UPLOAD_TOKEN_EXPIRY_SECONDS = 5 * 60;

const logger = rootLogger.child({ service: "incident-processor" });

// Time window for fetching logs (10 minutes before bug report)
const LOG_WINDOW_MS = 10 * 60 * 1000;

// Admin emails for notifications
const ADMIN_EMAILS = process.env.ADMIN_EMAILS || "isaiah@mentra.glass";
const admins = ADMIN_EMAILS.split(",").map((e) => e.trim());

/**
 * Queue an incident for background processing.
 * This is fire-and-forget - errors are logged but don't block the API response.
 */
export function queueIncidentProcessing(incidentId: string, userId: string): void {
  // Fire and forget - don't block the API response
  processIncident(incidentId, userId).catch((err) => {
    logger.error({ incidentId, userId, err }, "Background incident processing failed");
  });
}

/**
 * Send REQUEST_TELEMETRY to all active apps for a user via WebSocket.
 * Apps will asynchronously POST their logs to /api/incidents/:incidentId/logs.
 * This is fire-and-forget - we don't wait for the logs to arrive.
 */
function requestAppTelemetry(incidentId: string, userId: string): void {
  // Get the user's session
  const userSession = UserSession.getById(userId);
  if (!userSession) {
    logger.debug({ userId }, "No active session found for user - skipping app telemetry request");
    return;
  }

  // Get connected app WebSockets
  const appWebsockets = userSession.appWebsockets;
  if (appWebsockets.size === 0) {
    logger.debug({ userId }, "No connected apps for user - skipping app telemetry request");
    return;
  }

  const connectedApps = Array.from(appWebsockets.keys());
  logger.info(
    { userId, incidentId, appCount: connectedApps.length, apps: connectedApps },
    "Sending REQUEST_TELEMETRY to connected apps",
  );

  // Send REQUEST_TELEMETRY to each connected app with a signed upload token
  for (const [packageName, ws] of appWebsockets) {
    try {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        // Generate a signed upload token for this app to use when uploading logs
        const uploadToken = jwt.sign(
          {
            incidentId,
            userId,
            packageName,
          },
          AUGMENTOS_AUTH_JWT_SECRET,
          { expiresIn: UPLOAD_TOKEN_EXPIRY_SECONDS },
        );

        const message = {
          type: CloudToAppMessageType.REQUEST_TELEMETRY,
          incidentId,
          uploadToken,
          windowMs: LOG_WINDOW_MS,
          timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(message));
        logger.debug({ incidentId, packageName }, "Sent REQUEST_TELEMETRY to app");
      } else {
        logger.debug(
          { incidentId, packageName, readyState: ws.readyState },
          "App WebSocket not open - skipping telemetry request",
        );
      }
    } catch (err) {
      logger.warn({ incidentId, packageName, err }, "Failed to send REQUEST_TELEMETRY to app");
    }
  }
}

/**
 * Process an incident: fetch cloud logs, generate summary, create/update Linear ticket.
 */
async function processIncident(incidentId: string, userId: string): Promise<void> {
  logger.info({ incidentId, userId }, "Starting incident processing");

  const errors: string[] = [];

  try {
    // 1. Fetch cloud logs from BetterStack
    let cloudLogs: Awaited<ReturnType<typeof queryBetterStackLogs>> = [];
    try {
      cloudLogs = await queryBetterStackLogs(userId, LOG_WINDOW_MS);
      logger.info({ incidentId, cloudLogCount: cloudLogs.length }, "Fetched cloud logs");
    } catch (err) {
      logger.warn({ incidentId, err }, "Failed to fetch cloud logs from BetterStack");
      errors.push("BetterStack query failed");
    }

    // 2. Append cloud logs to incident in R2 (using direct function call, not HTTP)
    if (cloudLogs.length > 0) {
      try {
        await incidentStorage.appendLogs(incidentId, "cloudLogs", cloudLogs, "cloud");
        logger.info({ incidentId, count: cloudLogs.length }, "Appended cloud logs to incident");
      } catch (err) {
        logger.error({ incidentId, err }, "Failed to append cloud logs to R2");
        errors.push("R2 storage failed");
      }
    }

    // 2b. Request app telemetry via WebSocket (fire-and-forget)
    // Apps will POST their logs to /api/incidents/:incidentId/logs asynchronously
    try {
      requestAppTelemetry(incidentId, userId);
    } catch (err) {
      logger.warn({ incidentId, err }, "Failed to request app telemetry");
      // Don't add to errors array since this is optional
    }

    // 3. Get incident details for LLM analysis
    let incidentLogs;
    try {
      incidentLogs = await incidentStorage.getIncidentLogs(incidentId);
    } catch (err) {
      logger.error({ incidentId, err }, "Failed to retrieve incident logs");
      errors.push("Failed to retrieve logs");
    }

    // Console URL for humans, used in Linear tickets and notifications
    const consoleUrl = `https://console.mentra.glass/admin/incidents/${incidentId}`;

    // 4. LLM summary generation
    let summary: BugSummary | null = null;
    if (incidentLogs) {
      try {
        summary = await generateBugSummary(incidentLogs);
        logger.info({ incidentId, title: summary.title }, "Generated bug summary");
      } catch (err) {
        logger.warn({ incidentId, err }, "Failed to generate bug summary");
        errors.push("LLM summary failed");
        // Fallback summary - preserve user feedback even when LLM fails
        const feedback = incidentLogs.feedback as Record<string, unknown> | undefined;
        const systemInfo = feedback?.systemInfo as BugSummary["systemInfo"] | undefined;
        summary = {
          title: "Bug report (auto-summary failed)",
          description: "See logs for details",
          affectedComponents: [],
          severity: "medium",
          expectedBehavior: feedback?.expectedBehavior as string | undefined,
          actualBehavior: feedback?.actualBehavior as string | undefined,
          userSeverityRating: feedback?.severityRating as number | undefined,
          systemInfo,
        };
      }
    }

    // 5. Linear ticket creation/deduplication
    let linearIssueId: string | undefined;
    let linearIssueUrl: string | undefined;
    let isNewIssue = true;

    if (summary) {
      try {
        const linearResult = await createOrUpdateLinearIssue(incidentId, summary, consoleUrl);
        if (linearResult) {
          linearIssueId = linearResult.issueId;
          linearIssueUrl = linearResult.issueUrl;
          isNewIssue = linearResult.isNewIssue;
          logger.info({ incidentId, linearIssueId, isNewIssue }, "Linear ticket created/updated");
        }
      } catch (err) {
        logger.error({ incidentId, err }, "Failed to create Linear ticket");
        errors.push("Linear API failed");
      }
    }

    // 6. Send notifications with Linear link (or console link as fallback)
    const notificationUrl = linearIssueUrl || consoleUrl;

    // Slack notification (fire-and-forget)
    slackService
      .sendIncidentNotification(
        incidentId,
        userId,
        notificationUrl,
        consoleUrl,
        summary?.title,
        isNewIssue,
        incidentLogs?.feedback,
      )
      .catch((err) => {
        logger.warn({ incidentId, err }, "Slack notification failed");
        errors.push("Slack notification failed");
      });

    // Email notification
    try {
      await emailService.sendIncidentNotification(userId, incidentId, notificationUrl, incidentLogs?.feedback, admins);
    } catch (err) {
      logger.warn({ incidentId, err }, "Email notification failed");
      errors.push("Email notification failed");
    }

    // 7. Update incident status with Linear info and summary
    const finalStatus = errors.length === 0 ? "complete" : "partial";
    await Incident.updateOne(
      { incidentId },
      {
        $set: {
          status: finalStatus,
          summary: summary?.title,
          linearIssueId,
          linearIssueUrl,
          errorMessage: errors.length > 0 ? errors.join(", ") : undefined,
        },
      },
    );

    logger.info(
      {
        incidentId,
        userId,
        status: finalStatus,
        linearIssueId,
        linearIssueUrl,
        errors: errors.length > 0 ? errors : undefined,
        cloudLogCount: cloudLogs.length,
      },
      "Incident processing completed",
    );
  } catch (err) {
    // Catastrophic failure - mark as failed
    logger.error({ incidentId, userId, err }, "Incident processing failed catastrophically");

    await Incident.updateOne(
      { incidentId },
      {
        $set: {
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      },
    );
  }
}
