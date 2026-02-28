// cloud/src/api/client/user-settings.api.ts
// API endpoints for managing user settings

import { Router, Request, Response } from "express";
import {
  clientAuthWithUserSession,
  RequestWithUserSession,
} from "../middleware/client.middleware";

const router = Router();

// API Endpoints // /api/client/user/calendar/*
router.post("/", clientAuthWithUserSession, updateCalendar);

// Handler functions
// POST     /api/client/user/calendar
// BODY     { events: ExpoCalendarEvent[] }
async function updateCalendar(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const userSession = _req.userSession;
  const { events } = req.body;

  if (!events || typeof events !== "object") {
    return res.status(400).json({
      success: false,
      message: "events object required",
    });
  }

  try {
    await userSession.calendarManager.updateEventsFromAPI(events);
    return res.json({
      success: true,
      timestamp: new Date(),
    });
  } catch (error) {
    _req.logger.error(
      error,
      `Error updating settings for user ${userSession.userId}:`,
    );

    return res.status(500).json({
      success: false,
      message: "Failed to update user settings",
      timestamp: new Date(),
    });
  }
}

export default router;
