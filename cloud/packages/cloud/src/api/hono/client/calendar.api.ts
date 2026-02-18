/**
 * @fileoverview Hono calendar API routes.
 * API endpoints for managing user calendar.
 * Mounted at: /api/client/calendar
 */

import { Hono } from "hono";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "calendar.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, updateCalendar);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/calendar
 * Update calendar events from mobile client.
 * Body: { events: ExpoCalendarEvent[] }
 */
async function updateCalendar(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { events } = body as { events?: unknown[] };

    if (!events || !Array.isArray(events)) {
      return c.json(
        {
          success: false,
          message: "events array required",
        },
        400,
      );
    }

    await userSession.calendarManager.updateEventsFromAPI(events as any[]);

    return c.json({
      success: true,
      timestamp: new Date(),
    });
  } catch (error) {
    reqLogger.error(error, `Error updating calendar for user ${userSession.userId}:`);

    return c.json(
      {
        success: false,
        message: "Failed to update calendar",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
