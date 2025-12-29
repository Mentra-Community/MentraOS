/**
 * @fileoverview Hono feedback API routes.
 * API endpoints for sending user feedback.
 * Mounted at: /api/client/feedback
 */

import { Hono } from "hono";
import * as FeedbackService from "../../../services/client/feedback.service";
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
 * Submit user feedback.
 */
async function submitFeedback(c: AppContext) {
  const email = c.get("email")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { feedback: feedbackContent } = body as { feedback?: string };

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

    const feedback = await FeedbackService.submitFeedback(email, feedbackContent);

    return c.json({
      success: true,
      data: { feedback },
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
