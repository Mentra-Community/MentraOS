/**
 * @fileoverview Slack notification service for sending alerts to Slack channels.
 * Uses Slack Incoming Webhooks to post messages to dedicated channels.
 *
 * Note: Nightly build notifications are handled directly by GitHub Actions,
 * not through this service.
 */

import axios from "axios";
import { logger as rootLogger } from "../logging/pino-logger";
import type { FeedbackData } from "../../types/feedback.types";

const logger = rootLogger.child({ service: "slack.service" });

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  elements?: Array<{
    type: string;
    text?: {
      type: string;
      text: string;
      emoji?: boolean;
    };
    url?: string;
  }>;
}

interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

interface AppInfo {
  name?: string;
  packageName: string;
  appType?: string;
  description?: string;
}

/**
 * Slack notification service for sending alerts to various Slack channels.
 * Gracefully handles missing configuration and errors without throwing.
 */
export class SlackNotificationService {
  private feedbackWebhookUrl: string | undefined;
  private miniAppSubmissionWebhookUrl: string | undefined;

  constructor() {
    this.feedbackWebhookUrl = process.env.SLACK_WEBHOOK_USER_FEEDBACK;
    this.miniAppSubmissionWebhookUrl = process.env.SLACK_WEBHOOK_MINI_APP_SUBMISSION;

    if (!this.feedbackWebhookUrl) {
      logger.warn("SLACK_WEBHOOK_USER_FEEDBACK not configured - feedback notifications disabled");
    }
    if (!this.miniAppSubmissionWebhookUrl) {
      logger.warn("SLACK_WEBHOOK_MINI_APP_SUBMISSION not configured - mini app submission notifications disabled");
    }
  }

  /**
   * Send a message to a Slack webhook.
   * Gracefully handles errors without throwing.
   */
  private async sendToWebhook(
    webhookUrl: string | undefined,
    message: SlackMessage,
    context: string,
  ): Promise<boolean> {
    if (!webhookUrl) {
      logger.debug(`Slack notification skipped (${context}): webhook not configured`);
      return false;
    }

    try {
      await axios.post(webhookUrl, message, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      });
      logger.info(`Slack notification sent successfully (${context})`);
      return true;
    } catch (error) {
      logger.error(error, `Failed to send Slack notification (${context})`);
      return false;
    }
  }

  /**
   * Escape special characters for Slack mrkdwn format.
   */
  private escapeSlackText(text: string): string {
    // Escape &, <, > which have special meaning in Slack
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Notify the #user-feedback channel about new structured user feedback.
   */
  async notifyUserFeedback(userEmail: string, feedback: FeedbackData): Promise<boolean> {
    const timestamp = new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });

    const isBug = feedback.type === "bug";
    const headerEmoji = isBug ? ":bug:" : ":bulb:";
    const headerText = isBug ? "Bug Report" : "Feature Request";

    // Build main content fields
    const mainFields: Array<{ type: string; text: string }> = [];

    if (isBug) {
      if (feedback.expectedBehavior) {
        mainFields.push({
          type: "mrkdwn",
          text: `*Expected Behavior:*\n${this.escapeSlackText(feedback.expectedBehavior.substring(0, 500))}`,
        });
      }
      if (feedback.actualBehavior) {
        mainFields.push({
          type: "mrkdwn",
          text: `*Actual Behavior:*\n${this.escapeSlackText(feedback.actualBehavior.substring(0, 500))}`,
        });
      }
      if (feedback.severityRating !== undefined) {
        const severityEmoji = feedback.severityRating >= 4 ? ":red_circle:" : feedback.severityRating >= 3 ? ":large_orange_circle:" : ":large_green_circle:";
        mainFields.push({
          type: "mrkdwn",
          text: `*Severity:*\n${severityEmoji} ${feedback.severityRating}/5`,
        });
      }
    } else {
      if (feedback.feedbackText) {
        mainFields.push({
          type: "mrkdwn",
          text: `*Feedback:*\n${this.escapeSlackText(feedback.feedbackText.substring(0, 1000))}`,
        });
      }
      if (feedback.experienceRating !== undefined) {
        const safeRating = Math.max(0, Math.min(5, feedback.experienceRating));
        const stars = ":star:".repeat(safeRating);
        mainFields.push({
          type: "mrkdwn",
          text: `*Experience:*\n${stars} ${feedback.experienceRating}/5`,
        });
      }
    }

    // Build system info section
    const sys = feedback.systemInfo;
    const sysInfoParts: string[] = [];
    if (sys) {
      if (sys.appVersion) sysInfoParts.push(`App: ${this.escapeSlackText(sys.appVersion)}`);
      if (sys.platform) sysInfoParts.push(`Platform: ${this.escapeSlackText(sys.platform)}`);
      if (sys.deviceName) sysInfoParts.push(`Device: ${this.escapeSlackText(sys.deviceName)}`);
      if (sys.osVersion) sysInfoParts.push(`OS: ${this.escapeSlackText(sys.osVersion)}`);
      if (sys.glassesConnected !== undefined) sysInfoParts.push(`Glasses: ${sys.glassesConnected ? "Connected" : "Not connected"}`);
      if (sys.defaultWearable) sysInfoParts.push(`Wearable: ${this.escapeSlackText(sys.defaultWearable)}`);
    }

    // Build glasses info if connected
    const glasses = feedback.glassesInfo;
    const glassesInfoParts: string[] = [];
    if (glasses && sys?.glassesConnected) {
      if (glasses.modelName) glassesInfoParts.push(`Model: ${this.escapeSlackText(glasses.modelName)}`);
      if (glasses.fwVersion) glassesInfoParts.push(`FW: ${this.escapeSlackText(glasses.fwVersion)}`);
      if (glasses.batteryLevel !== undefined && glasses.batteryLevel >= 0) glassesInfoParts.push(`Battery: ${glasses.batteryLevel}%`);
    }

    // Contact email if Apple private relay user provided one
    const contactEmailField = feedback.contactEmail
      ? `\n*Contact:* ${this.escapeSlackText(feedback.contactEmail)}`
      : "";

    const blocks: SlackBlock[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${headerEmoji} ${headerText}`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*From:*\n${this.escapeSlackText(userEmail)}${contactEmailField}`,
          },
          {
            type: "mrkdwn",
            text: `*Submitted:*\n${timestamp}`,
          },
        ],
      },
    ];

    // Add main content fields (max 10 fields per section, 2 columns)
    if (mainFields.length > 0) {
      blocks.push({
        type: "section",
        fields: mainFields.slice(0, 10),
      });
    }

    // Add system info as context
    if (sysInfoParts.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*System Info:* ${sysInfoParts.join(" | ")}`,
        },
      });
    }

    // Add glasses info if available
    if (glassesInfoParts.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Glasses:* ${glassesInfoParts.join(" | ")}`,
        },
      });
    }

    const message: SlackMessage = {
      text: `New ${isBug ? "bug report" : "feature request"} from ${userEmail}`,
      blocks,
    };

    return this.sendToWebhook(this.feedbackWebhookUrl, message, "user-feedback");
  }

  /**
   * Notify the #user-feedback channel about legacy string feedback.
   */
  async notifyUserFeedbackLegacy(userEmail: string, feedback: string): Promise<boolean> {
    const timestamp = new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });

    // Truncate feedback if too long for Slack
    const truncatedFeedback = feedback.length > 2500
      ? feedback.substring(0, 2500) + "..."
      : feedback;

    // Escape and format as blockquote
    const escapedFeedback = this.escapeSlackText(truncatedFeedback);
    const quotedFeedback = escapedFeedback.split("\n").map(line => `>${line}`).join("\n");

    const message: SlackMessage = {
      text: `New feedback from ${userEmail}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "New User Feedback",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*From:*\n${this.escapeSlackText(userEmail)}`,
            },
            {
              type: "mrkdwn",
              text: `*Submitted:*\n${timestamp}`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: quotedFeedback,
          },
        },
      ],
    };

    return this.sendToWebhook(this.feedbackWebhookUrl, message, "user-feedback");
  }

  /**
   * Notify the #mini-app-submissions channel about new mini app submissions.
   */
  async notifyMiniAppSubmission(app: AppInfo, developerEmail: string): Promise<boolean> {
    const timestamp = new Date().toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });

    const consoleUrl = process.env.DEV_CONSOLE_FRONTEND_URL || "https://console.mentra.glass";
    const storeUrl = process.env.APP_STORE_URL || "https://apps.mentra.glass";

    // Escape user-provided content
    const escapedName = this.escapeSlackText(app.name || "Unnamed");
    const escapedPackage = this.escapeSlackText(app.packageName);
    const escapedEmail = this.escapeSlackText(developerEmail);
    const escapedType = this.escapeSlackText(app.appType || "standard");
    const escapedDescription = app.description
      ? this.escapeSlackText(app.description.substring(0, 500)) + (app.description.length > 500 ? "..." : "")
      : null;

    const message: SlackMessage = {
      text: `New app submitted: ${escapedName}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "New Mini App Submitted",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*App Name:*\n${escapedName}`,
            },
            {
              type: "mrkdwn",
              text: `*Package:*\n\`${escapedPackage}\``,
            },
            {
              type: "mrkdwn",
              text: `*Developer:*\n${escapedEmail}`,
            },
            {
              type: "mrkdwn",
              text: `*Type:*\n${escapedType}`,
            },
          ],
        },
        ...(escapedDescription
          ? [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Description:*\n${escapedDescription}`,
                },
              } as SlackBlock,
            ]
          : []),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `_Submitted: ${timestamp}_`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "View in Console",
                emoji: true,
              },
              url: `${consoleUrl}/apps`,
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "View in Store",
                emoji: true,
              },
              url: `${storeUrl}/package/${encodeURIComponent(app.packageName)}`,
            },
          ],
        },
      ],
    };

    return this.sendToWebhook(this.miniAppSubmissionWebhookUrl, message, "mini-app-submission");
  }
}

// Create singleton instance
export const slackService = new SlackNotificationService();
