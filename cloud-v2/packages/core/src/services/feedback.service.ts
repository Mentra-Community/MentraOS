/**
 * @fileoverview Non-incident feedback service.
 */

import { ulid } from "ulid";
import { FeedbackModel } from "../models/feedback.model";

export async function sendFeedback(input: {
  mentraUserId: string;
  feedback: string | Record<string, unknown>;
  phoneState?: Record<string, unknown>;
}): Promise<{ success: true }> {
  await FeedbackModel.create({
    feedbackId: `fb_${ulid()}`,
    mentraUserId: input.mentraUserId,
    feedback: typeof input.feedback === "string" ? { message: input.feedback } : input.feedback,
    phoneState: input.phoneState ?? null,
  });

  return { success: true };
}
