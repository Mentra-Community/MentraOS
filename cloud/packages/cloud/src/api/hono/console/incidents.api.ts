/**
 * @fileoverview Admin incidents API for viewing bug report logs.
 * Provides access to incident details stored in R2.
 * Console auth only (humans). For agent access, use /api/agent/incidents.
 * Mounted at: /api/console/admin/incidents
 */

import { Hono } from "hono";
import { isMentraAdmin } from "../../../services/core/admin.utils";
import { incidentStorage } from "../../../services/storage/incident-storage.service";
import { Incident } from "../../../models/incident.model";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "incidents.api" });

const app = new Hono<AppEnv>();

/**
 * Middleware to check admin access.
 * Console auth is applied by the parent router.
 */
app.use("*", async (c, next) => {
  const consoleAuth = c.get("console");
  const email = consoleAuth?.email;

  if (!email) {
    return c.json({ error: "Unauthorized", message: "Authentication required" }, 401);
  }

  if (!isMentraAdmin(email)) {
    return c.json({ error: "Forbidden", message: "Admin access required" }, 403);
  }

  return next();
});

// ============================================================================
// Routes
// ============================================================================

app.get("/", listIncidents);
app.get("/:incidentId", getIncident);
app.get("/:incidentId/logs", getIncidentLogs);
app.get("/:incidentId/attachments/:filename", getAttachment);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/console/admin/incidents
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
 * GET /api/console/admin/incidents/:incidentId
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
 * GET /api/console/admin/incidents/:incidentId/logs
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

/**
 * GET /api/console/admin/incidents/:incidentId/attachments/:filename
 * Proxy attachment image from R2 storage.
 * Returns the raw image with appropriate content-type header.
 */
async function getAttachment(c: AppContext) {
  const incidentId = c.req.param("incidentId");
  const filename = c.req.param("filename");

  try {
    const { buffer, mimeType } = await incidentStorage.getAttachment(incidentId, filename);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (errorMessage.includes("not found") || errorMessage.includes("NoSuchKey")) {
      return c.json({ error: "Attachment not found" }, 404);
    }

    logger.error({ error: err, incidentId, filename }, "Failed to get attachment");
    return c.json({ error: "Failed to get attachment" }, 500);
  }
}

export default app;
