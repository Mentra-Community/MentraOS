/**
 * @fileoverview Slack notifications for Cloud V2 reports.
 *
 * Cloud V2 replacement for the Cloud V1 feedback Slack path
 * (cloud/packages/cloud/src/services/notifications/slack.service.ts): bug
 * reports and feedback submitted through /api/client/reports post a summary
 * to the team channel via a Slack Incoming Webhook. Automatic reports can be
 * routed to their own channel via CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL,
 * falling back to the main webhook when unset — the same routing V1 used for
 * SLACK_WEBHOOK_AUTOMATIC_INCIDENTS.
 *
 * Best-effort by design: an unset webhook (local dev, tests) is a silent
 * skip, and send failures are logged, never thrown, so a notification can
 * never delay or fail the report API response. Callers fire-and-forget.
 */

import { createLogger } from "@mentra/cloud-shared";
import { createHmac } from "node:crypto";

const logger = createLogger("core").child({ service: "report-slack.service" });

const SLACK_TIMEOUT_MS = 10_000;
const REPORT_AGENT_ACTION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How much user-authored text a Slack field keeps, mirroring V1 limits. */
const BEHAVIOR_TEXT_MAX = 500;
const FEEDBACK_TEXT_MAX = 1000;
/** Trigger metadata and other short client strings (the API only requires
 * them to be non-empty, so none of them can be trusted to be short). */
const TRIGGER_TEXT_MAX = 300;
const SHORT_TEXT_MAX = 254;
/** Slack rejects the whole message when one section text exceeds 2000 chars,
 * which would silently lose the notification. Escaping expands text (up to
 * 5x), so this cap applies to the escaped result, with headroom for labels. */
const SLACK_FIELD_TEXT_MAX = 1900;

export interface ReportSlackNotification {
  reportId: string;
  mentraUserId: string;
  /** Account email resolved by the caller (best-effort); the message falls
   * back to the opaque mentraUserId when null so a GoTrue outage or an OEM
   * tenant never blocks the notification. */
  userEmail?: string | null;
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
  /** Engine-collected diagnostic context (Mixed in Mongo, read defensively);
   * feeds the compact System line. */
  context?: Record<string, unknown> | null;
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
  elements?: SlackButton[];
}

type SlackButton = {
  type: "button";
  text: { type: "plain_text"; text: string; emoji: boolean };
  style?: "primary" | "danger";
} & (
  | { url: string; action_id?: never; value?: never }
  | { action_id: string; value: string; url?: never }
);

/**
 * Post a report summary to the reports Slack channel. Resolves with
 * `{ok: false, skipped: true}` when CLOUD_REPORTS_SLACK_WEBHOOK_URL is unset
 * and `{ok: false}` on send failure; it never rejects.
 */
export async function notifyReportSlack(
  notification: ReportSlackNotification,
): Promise<ReportSlackResult> {
  const webhookUrl = webhookUrlFor(notification.kind);
  if (!webhookUrl) {
    logger.debug(
      { reportId: notification.reportId, kind: notification.kind },
      "no Slack webhook configured for this report kind; skipping notification",
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

/**
 * Automatic reports post to their own channel when
 * CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL is set, falling back to the main
 * webhook otherwise, so the feedback channel stays free of watchdog noise
 * without making the split mandatory.
 */
function webhookUrlFor(kind: ReportSlackNotification["kind"]): string | undefined {
  const main = process.env.CLOUD_REPORTS_SLACK_WEBHOOK_URL;
  if (kind === "automatic") {
    return process.env.CLOUD_REPORTS_SLACK_WEBHOOK_AUTOMATIC_URL || main;
  }
  return main;
}

function buildSlackMessage(notification: ReportSlackNotification): {
  text: string;
  blocks: SlackBlock[];
} {
  const { reportId, mentraUserId, kind, trigger, artifactCount } = notification;
  const userLabel = notification.userEmail || mentraUserId;
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

  const consoleUrl = adminConsoleReportUrl(reportId);
  const identityFields = [
    { type: "mrkdwn", text: `*User:*\n${slackText(userLabel, SHORT_TEXT_MAX)}` },
    { type: "mrkdwn", text: `*Report ID:*\n\`${slackText(reportId, SHORT_TEXT_MAX)}\`` },
    { type: "mrkdwn", text: `*Env:*\n${slackText(env, SHORT_TEXT_MAX)}` },
  ];
  if (artifactCount !== undefined) {
    identityFields.push({ type: "mrkdwn", text: `*Artifacts:*\n${artifactCount}` });
  }
  if (consoleUrl) {
    identityFields.push({ type: "mrkdwn", text: `*Console:*\n<${consoleUrl}|Open incident>` });
  }

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    { type: "section", fields: identityFields },
  ];

  const triggerFields: Array<{ type: string; text: string }> = [];
  if (typeof trigger?.source === "string") {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Trigger source:*\n${slackText(trigger.source, TRIGGER_TEXT_MAX)}`,
    });
  }
  if (typeof trigger?.reason === "string") {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Trigger reason:*\n${slackText(trigger.reason, TRIGGER_TEXT_MAX)}`,
    });
  }
  const sourceApplet = formatSourceApplet(trigger);
  if (sourceApplet) {
    triggerFields.push({
      type: "mrkdwn",
      text: `*Source applet:*\n${slackText(sourceApplet, TRIGGER_TEXT_MAX)}`,
    });
  }
  if (triggerFields.length > 0) {
    blocks.push({ type: "section", fields: triggerFields });
  }

  blocks.push(...buildBodyBlocks(notification));

  const systemLine = formatSystemLine(notification.context);
  if (systemLine) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*System:* ${slackText(systemLine, BEHAVIOR_TEXT_MAX)}` },
    });
  }

  const agentActionUrl = reportAgentActionUrl(notification);
  if (agentActionUrl) {
    const agentButton: SlackButton =
      process.env.CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED === "true"
        ? {
            type: "button",
            text: { type: "plain_text", text: "Run Fix Agent", emoji: true },
            action_id: "run_fix_agent",
            style: "primary",
            value: agentActionUrl,
          }
        : {
            type: "button",
            text: { type: "plain_text", text: "Run Fix Agent", emoji: true },
            style: "primary",
            url: agentActionUrl,
          };
    blocks.push({
      type: "actions",
      elements: [agentButton],
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `_Submitted: ${timestamp}_` },
  });

  const fallbackParts = [
    `New ${kind} report from ${truncate(userLabel, SHORT_TEXT_MAX)} (${env})`,
    `Report ID: ${reportId}`,
    ...(consoleUrl ? [`Console: ${consoleUrl}`] : []),
    ...(typeof trigger?.reason === "string"
      ? [`Trigger: ${truncate(trigger.reason, TRIGGER_TEXT_MAX)}`]
      : []),
    ...(artifactCount !== undefined ? [`Artifacts: ${artifactCount}`] : []),
  ];

  return { text: fallbackParts.join("\n"), blocks };
}

/**
 * Signed, expiring action for the private agent controller. Until Slack's
 * Interactivity Request URL is configured, the default URL button keeps the
 * confirmation-page fallback working. Explicitly setting
 * CLOUD_REPORT_AGENT_SLACK_INTERACTIVITY_ENABLED=true switches to a one-click
 * action value, which Slack sends only when a human presses the button. Bug
 * reports are the deliberately narrow MVP scope; feedback and automatic
 * diagnostics never receive it.
 */
function reportAgentActionUrl(notification: ReportSlackNotification): string | null {
  if (notification.kind !== "bug") return null;
  const configuredBase = process.env.CLOUD_REPORT_AGENT_URL?.trim();
  const signingSecret = process.env.CLOUD_REPORT_AGENT_SIGNING_SECRET;
  const environment = reportAgentEnvironment();
  if (!configuredBase || !signingSecret || signingSecret.length < 32 || !environment) return null;

  try {
    const expires = Math.floor(Date.now() / 1000) + REPORT_AGENT_ACTION_TTL_SECONDS;
    const payload = `${notification.reportId}|${environment}|${expires}`;
    const signature = createHmac("sha256", signingSecret).update(payload).digest("hex");
    const url = new URL("/actions/report", withHttpsScheme(configuredBase));
    url.searchParams.set("reportId", notification.reportId);
    url.searchParams.set("environment", environment);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature);
    return url.toString();
  } catch (error) {
    logger.warn(
      { error: (error as Error)?.message },
      "invalid CLOUD_REPORT_AGENT_URL; omitting report agent action",
    );
    return null;
  }
}

function reportAgentEnvironment(): "prod" | "staging" | "dev" | null {
  const environment = process.env.CLOUD_CORE_ENVIRONMENT;
  if (environment === "prod" || environment === "production") return "prod";
  if (environment === "staging" || environment === "dev") return environment;
  return null;
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
        text: `*Actual:*\n${slackText(report.actualBehavior, BEHAVIOR_TEXT_MAX)}`,
      });
    }
    if (typeof report.expectedBehavior === "string") {
      detailFields.push({
        type: "mrkdwn",
        text: `*Expected:*\n${slackText(report.expectedBehavior, BEHAVIOR_TEXT_MAX)}`,
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
        text: { type: "mrkdwn", text: `*Contact:* ${slackText(report.contactEmail, SHORT_TEXT_MAX)}` },
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
        text: `*Feedback:*\n${slackText(message, FEEDBACK_TEXT_MAX)}`,
      },
    });
    if (typeof feedback.type === "string") {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Type:* ${slackText(feedback.type, SHORT_TEXT_MAX)}` },
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
        text: { type: "mrkdwn", text: `*Contact:* ${slackText(feedback.contactEmail, SHORT_TEXT_MAX)}` },
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

/**
 * Deep link to this report in the admin console (Incident system page).
 * An explicit CLOUD_ADMIN_CONSOLE_URL wins; otherwise the URL is derived from
 * the deployment environment per docs/runbooks/cloudflare/pages-websites.md
 * (admin.<env>.mentraglass.com, admin.mentraglass.com for prod). Unknown
 * environments get no link rather than a wrong one.
 */
function adminConsoleReportUrl(reportId: string): string | null {
  const env = process.env.CLOUD_CORE_ENVIRONMENT;
  const configured = process.env.CLOUD_ADMIN_CONSOLE_URL;
  const base = configured
    ? withHttpsScheme(configured)
    : env === "prod" || env === "production"
      ? "https://admin.mentraglass.com"
      : env === "dev" || env === "staging"
        ? `https://admin.${env}.mentraglass.com`
        : null;
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/?report=${encodeURIComponent(reportId)}`;
}

/**
 * Slack treats a schemeless link target as an in-app relative path and
 * renders it as app.slack.com/client/<team>/admin.dev.mentraglass.com/...,
 * so a configured console base must carry a scheme before it goes into the
 * message.
 */
function withHttpsScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Compact V1-style system summary built from the engine-collected context
 * (see mobile island diagnosticContext). Context is client-sourced Mixed
 * data, so every field is read defensively and value lengths are capped;
 * the assembled line is escaped by the caller via slackText.
 */
function formatSystemLine(context: Record<string, unknown> | null | undefined): string | null {
  if (!context || typeof context !== "object") return null;
  const app = asRecord(context.app);
  const phone = asRecord(context.phone);
  const glasses = asRecord(context.glasses);
  const settings = asRecord(context.settings);

  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      parts.push(`${label}: ${truncate(value.trim(), 80)}`);
    }
  };
  push("App", app?.appVersion);
  push("Platform", phone?.platform);
  push("Device", phone?.deviceName);
  push("OS", phone?.osVersion);
  if (glasses) {
    const connection = glassesConnectionLabel(glasses);
    const model = firstNonEmptyString(glasses.deviceModel, glasses.modelName);
    if (connection || model) {
      const suffix = model ? ` (${truncate(model, 80)})` : "";
      parts.push(`Glasses: ${connection ?? "Unknown"}${suffix}`);
    }
  }
  push("Wearable", settings?.defaultWearable);

  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Human label for the glasses link state. The mobile engine sends the raw
 * glasses store state, where `connection` is a `{ state: "connected" | ... }`
 * object (btsdk GlassesConnectionStatus); a plain string or a normalized
 * `connected` boolean are accepted for robustness against client versions.
 */
function glassesConnectionLabel(glasses: Record<string, unknown>): string | null {
  if (typeof glasses.connected === "boolean") {
    return glasses.connected ? "Connected" : "Disconnected";
  }
  const connection = glasses.connection;
  const state =
    typeof connection === "string" ? connection : asRecord(connection)?.state;
  if (typeof state === "string" && state.trim()) {
    const label = truncate(state.trim(), 40);
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Prepare client-sourced text for a Slack field: cap at the field's own
 * length budget, escape, then hard-cap the escaped result under Slack's
 * 2000-char section text limit. A truncated trailing entity is stripped
 * rather than left dangling.
 */
function slackText(text: string, max: number): string {
  const escaped = escapeSlackText(truncate(text, max));
  if (escaped.length <= SLACK_FIELD_TEXT_MAX) return escaped;
  return `${escaped.slice(0, SLACK_FIELD_TEXT_MAX).replace(/&[a-z]*$/i, "")}...`;
}

/** Escape &, <, > which have special meaning in Slack mrkdwn. */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
