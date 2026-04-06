/**
 * @fileoverview Hono session-health API route.
 * Lets the mobile client check whether its WebSocket + UserSession are alive.
 * Mounted at: /api/client/session-health
 */

import { Hono } from "hono";
import { clientAuth } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import { WebSocketReadyState } from "../../../services/websocket/types";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "session-health.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", clientAuth, checkSessionHealth);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/client/session-health
 *
 * Returns whether the user has an active UserSession and an open WebSocket.
 * The client calls this when it suspects its WebSocket is dead (missed pong).
 *
 * - If both exist and the WebSocket is OPEN → 200 { healthy: true }
 * - Otherwise → 503 { error: "NO_ACTIVE_SESSION_OR_WEBSOCK ET" }
 */
async function checkSessionHealth(c: AppContext) {
  const email = c.get("email") ?? "";
  const reqLogger = c.get("logger") || logger;

  const userSession = email ? UserSession.getById(email) : undefined;

  const hasSession = !!userSession;
  const hasOpenWebSocket =
    hasSession && !!userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN;

  if (hasSession && hasOpenWebSocket) {
    reqLogger.debug({ email }, "session-health: healthy");
    return c.json({ healthy: true });
  }

  reqLogger.error(
    {
      userId: email,
      error: "NO_ACTIVE_SESSION_OR_WEBSOCKET",
      hasSession,
      hasOpenWebSocket,
      disconnectedAt: hasSession ? (userSession.disconnectedAt?.toISOString() ?? null) : null,
    },
    `session-health: no active session or WebSocket for user: ${email}`,
  );

  return c.json(
    {
      error: "NO_ACTIVE_SESSION_OR_WEBSOCKET",
      message: "No active WebSocket connection and no active user session for this client.",
    },
    503,
  );
}

export default app;
