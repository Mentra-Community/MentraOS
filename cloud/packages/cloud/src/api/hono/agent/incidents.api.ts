/**
 * @fileoverview Agent incidents API for coding agents to fetch bug report logs.
 * Uses X-Agent-Key authentication for automated access.
 * Mounted at: /api/agent/incidents
 */

import { Hono } from "hono";
import { incidentStorage } from "../../../services/storage/incident-storage.service";
import { Incident } from "../../../models/incident.model";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "agent-incidents.api" });

const app = new Hono<AppEnv>();

/**
 * Middleware to check agent API key.
 */
app.use("*", async (c, next) => {
  const agentKey = c.req.header("X-Agent-Key");
  const expectedAgentKey = process.env.MENTRA_AGENT_API_KEY;

  if (!expectedAgentKey) {
    logger.error("MENTRA_AGENT_API_KEY not configured");
    return c.json({ error: "Agent API not configured" }, 500);
  }

  if (!agentKey || agentKey !== expectedAgentKey) {
    return c.json({ error: "Unauthorized", message: "Valid X-Agent-Key required" }, 401);
  }

  return next();
});

// ============================================================================
// Routes
// ============================================================================

app.get("/", listIncidents);
app.get("/:incidentId", getIncident);
app.get("/:incidentId/logs", getIncidentLogs);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/agent/incidents
 * List recent incidents.
 */
async function listIncidents(c: AppContext) {
  try {
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const incidents = await Incident.find()
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .select("incidentId userId status summary linearIssueId linearIssueUrl errorMessage createdAt updatedAt")
      .lean();

    const total = await Incident.countDocuments();

    return c.json({
      success: true,
      data: incidents,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + incidents.length < total,
      },
    });
  } catch (err) {
    logger.error({ error: err }, "Failed to list incidents");
    return c.json({ error: "Failed to list incidents" }, 500);
  }
}

/**
 * GET /api/agent/incidents/:incidentId
 * Get incident metadata (from MongoDB).
 */
async function getIncident(c: AppContext) {
  const incidentId = c.req.param("incidentId");

  try {
    const incident = await Incident.findOne({ incidentId }).lean();

    if (!incident) {
      return c.json({ error: "Incident not found" }, 404);
    }

    return c.json({
      success: true,
      data: incident,
    });
  } catch (err) {
    logger.error({ error: err, incidentId }, "Failed to get incident");
    return c.json({ error: "Failed to get incident" }, 500);
  }
}

/**
 * GET /api/agent/incidents/:incidentId/logs
 * Get full incident logs from R2 storage.
 */
async function getIncidentLogs(c: AppContext) {
  const incidentId = c.req.param("incidentId");

  try {
    const logs = await incidentStorage.getIncidentLogs(incidentId);

    return c.json({
      success: true,
      data: logs,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (errorMessage.includes("not found") || errorMessage.includes("NoSuchKey")) {
      return c.json({ error: "Incident logs not found" }, 404);
    }

    logger.error({ error: err, incidentId }, "Failed to get incident logs");
    return c.json({ error: "Failed to get incident logs" }, 500);
  }
}

export default app;
