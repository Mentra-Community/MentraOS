/**
 * @fileoverview Slack notifications for Cloud V2 miniapp release submissions.
 *
 * Cloud V2 replacement for the Cloud V1 #mini-app-submissions Slack path
 * (cloud/packages/cloud/src/services/notifications/slack.service.ts,
 * notifyMiniAppSubmission): when a developer submits a release for review,
 * a summary is posted to the team channel via a Slack Incoming Webhook.
 *
 * Best-effort by design: an unset CLOUD_MINIAPP_SLACK_WEBHOOK_URL (local dev,
 * tests) is a silent skip, and send failures are logged, never thrown, so a
 * notification can never delay or fail the submit API response. Callers
 * fire-and-forget.
 */

import { createLogger } from "@mentra/cloud-shared";

const logger = createLogger("core").child({ service: "miniapp-slack.service" });

const SLACK_TIMEOUT_MS = 10_000;

/** How much developer-authored description a Slack field keeps, mirroring V1. */
const DESCRIPTION_TEXT_MAX = 500;
const SHORT_TEXT_MAX = 254;
/** Slack rejects the whole message when one section text exceeds 2000 chars,
 * which would silently lose the notification. Escaping expands text (up to
 * 5x), so this cap applies to the escaped result, with headroom for labels. */
const SLACK_FIELD_TEXT_MAX = 1900;

export interface MiniAppSubmissionSlackNotification {
  releaseId: string;
  packageName: string;
  version: string;
  appName: string;
  developerEmail?: string | null;
  orgId: string;
  description?: string | null;
  /** Release manifest snapshot (a Mixed document field), read defensively. */
  manifest?: Record<string, unknown> | null;
}

export interface MiniAppSlackResult {
  ok: boolean;
  skipped?: boolean;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
}

/**
 * Post a release-submission summary to the miniapp submissions Slack channel.
 * Resolves with `{ok: false, skipped: true}` when
 * CLOUD_MINIAPP_SLACK_WEBHOOK_URL is unset and `{ok: false}` on send failure;
 * it never rejects.
 */
export async function notifyMiniAppSubmissionSlack(
  notification: MiniAppSubmissionSlackNotification,
): Promise<MiniAppSlackResult> {
  const webhookUrl = process.env.CLOUD_MINIAPP_SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.debug(
      { releaseId: notification.releaseId, packageName: notification.packageName },
      "CLOUD_MINIAPP_SLACK_WEBHOOK_URL not set; skipping miniapp submission Slack notification",
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
          releaseId: notification.releaseId,
          packageName: notification.packageName,
          status: res.status,
          body: await res.text().catch(() => ""),
        },
        "miniapp submission Slack notification failed",
      );
      return { ok: false };
    }
    logger.info(
      { releaseId: notification.releaseId, packageName: notification.packageName },
      "miniapp submission Slack notification sent",
    );
    return { ok: true };
  } catch (error) {
    logger.error(
      {
        releaseId: notification.releaseId,
        packageName: notification.packageName,
        error: (error as Error)?.message,
      },
      "miniapp submission Slack notification error",
    );
    return { ok: false };
  }
}

function buildSlackMessage(notification: MiniAppSubmissionSlackNotification): {
  text: string;
  blocks: SlackBlock[];
} {
  const { packageName, version, appName, developerEmail, orgId, description } = notification;
  const env = environmentLabel();
  const appType = extractAppType(notification.manifest);
  const timestamp = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  });

  const fields = [
    { type: "mrkdwn", text: `*App Name:*\n${slackText(appName || "Unnamed", SHORT_TEXT_MAX)}` },
    { type: "mrkdwn", text: `*Package:*\n\`${slackText(packageName, SHORT_TEXT_MAX)}\`` },
    { type: "mrkdwn", text: `*Version:*\n${slackText(version, SHORT_TEXT_MAX)}` },
    {
      type: "mrkdwn",
      text: `*Developer:*\n${slackText(developerEmail || "unknown", SHORT_TEXT_MAX)}`,
    },
    { type: "mrkdwn", text: `*Org:*\n\`${slackText(orgId, SHORT_TEXT_MAX)}\`` },
    { type: "mrkdwn", text: `*Env:*\n${slackText(env, SHORT_TEXT_MAX)}` },
  ];
  if (appType) {
    fields.push({ type: "mrkdwn", text: `*Type:*\n${slackText(appType, SHORT_TEXT_MAX)}` });
  }

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "New Mini App Release Submitted", emoji: true },
    },
    { type: "section", fields },
  ];

  if (typeof description === "string" && description.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Description:*\n${slackText(description, DESCRIPTION_TEXT_MAX)}`,
      },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `_Submitted: ${timestamp}_` },
  });

  const fallbackParts = [
    `New miniapp release submitted: ${slackText(appName || "Unnamed", SHORT_TEXT_MAX)} v${slackText(version, SHORT_TEXT_MAX)} (${slackText(packageName, SHORT_TEXT_MAX)})`,
    `Developer: ${slackText(developerEmail || "unknown", SHORT_TEXT_MAX)} (${slackText(env, SHORT_TEXT_MAX)})`,
  ];

  return { text: fallbackParts.join("\n"), blocks };
}

/** V2 manifests have no required type field, so surface one only when the
 * developer-supplied manifest carries a plausible string. */
function extractAppType(manifest: Record<string, unknown> | null | undefined): string | null {
  for (const candidate of [manifest?.type, manifest?.appType]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Which deployment the submission came from (dev/staging/prod), so one
 * channel can receive several environments without ambiguity.
 */
function environmentLabel(): string {
  return process.env.CLOUD_CORE_ENVIRONMENT || "unknown";
}

/**
 * Prepare developer-sourced text for a Slack field: cap at the field's own
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
