/**
 * @fileoverview Slack notifications for Cloud V2 reports.
 *
 * Cloud V2 replacement for the Cloud V1 feedback Slack path
 * (cloud/packages/cloud/src/services/notifications/slack.service.ts): bug
 * reports and feedback submitted through /api/client/reports post a summary
 * to the team channel via a Slack Incoming Webhook.
 *
 * Best-effort by design: an unset CLOUD_REPORTS_SLACK_WEBHOOK_URL (local dev,
 * tests) is a silent skip, and send failures are logged, never thrown, so a
 * notification can never delay or fail the report API response. Callers
 * fire-and-forget.
 */

import { createLogger } from "@mentra/cloud-shared";

const logger = createLogger("core").child({ service: "report-slack.service" });

const SLACK_TIMEOUT_MS = 10_000;

/** How much user-authored text a Slack field keeps, mirroring V1 limits. */
const BEHAVIOR_TEXT_MAX = 500;
const FEEDBACK_TEXT_MAX = 1000;

export interface ReportSlackNotification {
  reportId: string;
  mentraUserId: string;
  kind: "bug" | "feedback" | "automatic";
  /** Trigger/report/feedback are snapshots of the stored (Mixed) report
   * fields, so every property is read defensively. */
  trigger?: {
    type?: string;
    source?: string;
    reason?: string;
    sourceAppletPackageName?: string;
    sourceAppletName?: string;
  } | null;
  report?: {
    actualBehavior?: string;
    expectedBehavior?: string;
    userSeverity?: number;
    contactEmail?: string;
  } | null;
  feedback?: Record<string, unknown> | null;
  /** Set on ready-time notifications: how many artifacts were attached. */
  artifactCount?: number;
}

export interface ReportSlackResult {
  ok: boolean;
  skipped?: boolean;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
}

/**
 * Post a report summary to the reports Slack channel. Resolves with
 * `{ok: false, skipped: true}` when CLOUD_REPORTS_SLACK_WEBHOOK_URL is unset
 * and `{ok: false}` on send failure; it never rejects.
 */
export async function notifyReportSlack(
  notification: ReportSlackNotification,
): Promise<ReportSlackResult> {
  const webhookUrl = process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.debug(
      { reportId: notification.reportId },
      "CLOUD_REPORTS_SLACK_WEBHOOK_URL not set; skipping report Slack notification",
    );
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSlackMessage(notification)),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error(
        {
          reportId: notification.reportId,
          status: res.status,
          body: await res.text().catch(() => ""),
        },
        "report Slack notification failed",
      );
      return { ok: false };
    }
    logger.info({ reportId: notification.reportId }, "report Slack notification sent");
    return { ok: true };
  } catch (error) {
    logger.error(
      { reportId: notification.reportId, error: (error as Error)?.message },
      "report Slack notification error",
    );
    return { ok: false };
  }
}

function buildSlackMessage(notification: ReportSlackNotification): {
  text: string;
  blocks: SlackBlock[];
} {
  const { reportId, mentraUserId, kind, trigger, artifactCount } = notification;
  const env = environmentLabel();
  const header =
    kind === "bug"
      ? ":bug: New Bug Report"
      : kind === "feedback"
        ? ":bulb: New Feedback"
        : ":robot_face: New Automatic Report";
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  });

  const identityFields = [
    { type: "mrkdwn", text: `*User:*\n${escapeSlackText(mentraUserId)}` },
    { type: "mrkdwn", text: `*Report ID:*\n\`${escapeSlackText(reportId)}\`` },
    { type: "mrkdwn", text: `*Env:*\n${escapeSlackText(env)}` },
  ];
  if (artifactCount !== undefined) {
    identityFields.push({ type: "mrkdwn", text: `*Artifacts:*\n${artifactCount}` });
  }

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    { type: "section", fields: identityFields },
  ];

  const triggerFields: Array<{ type: string; text: string }> = [];
  if (typeof trigger?.source === "string") {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Trigger source:*\n${escapeSlackText(trigger.source)}`,
    });
  }
  if (typeof trigger?.reason === "string") {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Trigger reason:*\n${escapeSlackText(trigger.reason)}`,
    });
  }
  const sourceApplet = formatSourceApplet(trigger);
  if (sourceApplet) {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Source applet:*\n${escapeSlackText(sourceApplet)}`,
    });
  }
  if (triggerFields.length > 0) {
    blocks.push({ type: "section", fields: triggerFields });
  }

  blocks.push(...buildBodyBlocks(notification));
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `_Submitted: ${timestamp}_` },
  });

  const fallbackParts = [
    `New ${kind} report from ${mentraUserId} (${env})`,
    `Report ID: ${reportId}`,
    ...(typeof trigger?.reason === "string" ? [`Trigger: ${trigger.reason}`] : []),
    ...(artifactCount !== undefined ? [`Artifacts: ${artifactCount}`] : []),
  ];

  return { text: fallbackParts.join("\n"), blocks };
}

/** Kind-specific body: bug/automatic report details, or the feedback text. */
function buildBodyBlocks(notification: ReportSlackNotification): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  const report = notification.report;
  if (report) {
    const detailFields: Array<{ type: string; text: string }> = [];
    if (typeof report.actualBehavior === "string") {
      detailFields.push({
        type: "mrkdwn",
        text: `*Actual:*\n${escapeSlackText(truncate(report.actualBehavior, BEHAVIOR_TEXT_MAX))}`,
      });
    }
    if (typeof report.expectedBehavior === "string") {
      detailFields.push({
        type: "mrkdwn",
        text: `*Expected:*\n${escapeSlackText(truncate(report.expectedBehavior, BEHAVIOR_TEXT_MAX))}`,
      });
    }
    if (detailFields.length > 0) {
      blocks.push({ type: "section", fields: detailFields });
    }
    if (typeof report.userSeverity === "number") {
      const severityEmoji =
        report.userSeverity >= 4
          ? ":red_circle:"
          : report.userSeverity >= 3
            ? ":large_orange_circle:"
            : ":large_green_circle:";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Severity:* ${severityEmoji} ${report.userSeverity}/5`,
        },
      });
    }
    if (typeof report.contactEmail === "string") {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Contact:* ${escapeSlackText(report.contactEmail)}` },
      });
    }
  }

  const feedback = notification.feedback;
  if (feedback) {
    const message =
      typeof feedback.message === "string"
        ? feedback.message
        : JSON.stringify(feedback);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Feedback:*\n${escapeSlackText(truncate(message, FEEDBACK_TEXT_MAX))}`,
      },
    });
    if (typeof feedback.type === "string") {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Type:* ${escapeSlackText(feedback.type)}` },
      });
    }
    if (typeof feedback.experienceRating === "number") {
      const safeRating = Math.max(0, Math.min(5, Math.round(feedback.experienceRating)));
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Experience:* ${":star:".repeat(safeRating)} ${feedback.experienceRating}/5`,
        },
      });
    }
    if (typeof feedback.contactEmail === "string") {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Contact:* ${escapeSlackText(feedback.contactEmail)}` },
      });
    }
  }

  return blocks;
}

function formatSourceApplet(trigger: ReportSlackNotification["trigger"]): string | null {
  const name = typeof trigger?.sourceAppletName === "string" ? trigger.sourceAppletName : null;
  const packageName =
    typeof trigger?.sourceAppletPackageName === "string" ? trigger.sourceAppletPackageName : null;
  if (name && packageName) return `${name} (${packageName})`;
  return name ?? packageName;
}

/**
 * Which deployment the report came from (dev/staging/prod), so one channel
 * can receive several environments without ambiguity.
 */
function environmentLabel(): string {
  return process.env.CLOUD_CORE_ENVIRONMENT || "unknown";
}

/** Escape &, <, > which have special meaning in Slack mrkdwn. */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
