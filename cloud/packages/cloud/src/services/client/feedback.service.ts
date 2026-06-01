// services/client/feedback.service.ts
// Business logic for managing user feedback
//
// This service handles feature requests and legacy bug reports (old clients).
// New clients should use POST /api/incidents for bug reports instead.

import { Feedback } from "../../models/feedback.model";
import { queueFeedbackReceipt } from "./feedback-receipt.service";
import { slackService } from "../notifications/slack.service";
import type { FeedbackData, PhoneStateSnapshot, FeedbackResponse } from "../../types/feedback.types";
import { logger as rootLogger } from "../logging/pino-logger";

const logger = rootLogger.child({ service: "feedback.service" });

// Re-export for consumers who import from this service
export type { FeedbackData, PhoneStateSnapshot, FeedbackResponse } from "../../types/feedback.types";

/**
 * Submit user feedback.
 * Handles feature requests and legacy bug reports from old clients.
 * New clients should use POST /api/incidents for bug reports.
 *
 * This endpoint sends email + Slack notifications but does NOT create incidents.
 * For the full incident flow (cloud logs, Linear tickets, etc.), use /api/incidents.
 */
export async function submitFeedback(
  email: string,
  feedback: string | FeedbackData,
  _phoneState?: PhoneStateSnapshot,
): Promise<FeedbackResponse> {
  // Determine if this is legacy (string) or new (object) format
  const isStructured = typeof feedback === "object";

  // For database storage, serialize structured data to JSON string
  const feedbackString = isStructured ? JSON.stringify(feedback) : feedback;

  // Save feedback to database
  await Feedback.create({
    email,
    feedback: feedbackString,
  });

  logger.info(
    { userId: email, type: isStructured ? feedback.type : "legacy" },
    "Feedback submitted",
  );

  // Send feedback to Slack channel (fire-and-forget to not delay API response)
  if (isStructured) {
    slackService.notifyUserFeedback(email, feedback).catch(() => {});
  } else {
    // Legacy format - just send as plain text
    slackService.notifyUserFeedbackLegacy(email, feedback).catch(() => {});
  }

  queueFeedbackReceipt(email, feedback);

  return {
    success: true,
  };
}
