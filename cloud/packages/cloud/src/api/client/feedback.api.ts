// cloud/src/api/client/feedback.api.ts
// API endpoints for sending user feedback

import { Router, Request, Response } from "express";
import * as FeedbackService from "../../services/client/feedback.service";
import {
  clientAuthWithEmail,
  RequestWithEmail,
} from "../middleware/client.middleware";

const router = Router();

// API Endpoints // /api/client/feedback*
router.post("/", clientAuthWithEmail, submitFeedback);

// Handler functions
// Get all settings for a user
async function submitFeedback(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;
  try {
    const feedback = await FeedbackService.submitFeedback(
      email,
      req.body.feedback,
    );
    res.json({
      success: true,
      data: { feedback },
      timestamp: new Date(),
    });
  } catch (error) {
    _req.logger.error(error, `Error submitting feedback for user ${email}`);
    res.status(500).json({
      success: false,
      message: "Failed to submit feedback",
      timestamp: new Date(),
    });
  }
}

export default router;

console.log("testing");
