/**
 * @fileoverview Hono feedback API routes.
 * API endpoints for sending user feedback.
 * Mounted at: /api/client/feedback
 */

import { Hono } from "hono";
import * as FeedbackService from "../../../services/client/feedback.service";
import type { FeedbackData, PhoneStateSnapshot } from "../../../services/client/feedback.service";
import { clientAuth } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "feedback.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, submitFeedback);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/feedback
 * Submit user feedback (feature requests and legacy bug reports).
 * Accepts either:
 * - Legacy format: { feedback: "string" }
 * - New structured format: { feedback: { type: "bug" | "feature", ... }, phoneState?: {...} }
 *
 * Note: For bug reports with full incident tracking, use POST /api/incidents instead.
 */
async function submitFeedback(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { feedback: feedbackContent, phoneState } = body as {
      feedback?: string | FeedbackData;
      phoneState?: PhoneStateSnapshot;
    };

    if (!feedbackContent) {
      return c.json(
        {
          success: false,
          message: "Feedback content required",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Validate structured feedback has required 'type' field
    if (typeof feedbackContent === "object" && !("type" in feedbackContent)) {
      return c.json(
        {
          success: false,
          message: "Structured feedback must include 'type' field ('bug' or 'feature')",
          timestamp: new Date(),
        },
        400,
      );
    }

    const result = await FeedbackService.submitFeedback(email, feedbackContent, phoneState);

    return c.json({
      success: result.success,
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, `Error submitting feedback for user ${email}`);
    return c.json(
      {
        success: false,
        message: "Failed to submit feedback",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
