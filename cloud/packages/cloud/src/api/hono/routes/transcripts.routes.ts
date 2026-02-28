/**
 * @fileoverview Hono transcripts routes.
 * Session transcript access endpoints.
 * Mounted at: /api/transcripts
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "transcripts.routes" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/:appSessionId", getTranscripts);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/transcripts/:appSessionId
 * Get transcripts for a session.
 *
 * Headers:
 *   - X-API-Key: <app-api-key>
 *   - X-Package-Name: <app-package-name>
 *
 * Query Parameters:
 *   - duration: number (seconds to look back)
 *   - startTime?: ISO timestamp (optional alternative to duration)
 *   - endTime?: ISO timestamp (optional alternative to duration)
 *   - language?: string (language code, e.g. 'en-US', 'fr-FR', defaults to 'en-US')
 */
async function getTranscripts(c: AppContext) {
  try {
    const appSessionId = c.req.param("appSessionId");
    const duration = c.req.query("duration");
    const startTime = c.req.query("startTime");
    const endTime = c.req.query("endTime");
    const language = c.req.query("language") || "en-US";

    logger.debug({ appSessionId, language }, `Fetching transcripts for session`);

    // Validate that at least one time parameter is provided
    if (!duration && !startTime && !endTime) {
      return c.json({ error: "duration, startTime, or endTime is required" }, 400);
    }

    // Extract user session ID from app session ID (format: userSessionId-appPackageName)
    const userSessionId = appSessionId.split("-")[0];
    const userSession = UserSession.getById(userSessionId);

    if (!userSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Build time range object for the transcription manager
    const timeRange: {
      duration?: number;
      startTime?: Date;
      endTime?: Date;
    } = {};

    if (duration) {
      timeRange.duration = parseInt(duration, 10);
    }

    if (startTime) {
      timeRange.startTime = new Date(startTime);
    }

    if (endTime) {
      timeRange.endTime = new Date(endTime);
    }

    // Get transcript history from the transcription manager
    const transcriptSegments = userSession.transcriptionManager.getTranscriptHistory(
      language,
      Object.keys(timeRange).length > 0 ? timeRange : undefined,
    );

    logger.debug(
      { segmentCount: transcriptSegments.length, language },
      `Returning transcript segments for language ${language}`,
    );

    return c.json({
      language: language,
      segments: transcriptSegments,
    });
  } catch (error) {
    logger.error(error, "Error fetching transcripts");
    return c.json({ error: "Error fetching transcripts" }, 500);
  }
}

export default app;
