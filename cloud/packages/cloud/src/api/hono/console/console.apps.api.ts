/**
 * @fileoverview Hono console apps API routes.
 * Console app management endpoints for authenticated console users.
 * Mounted at: /api/console/apps
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "console.apps.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", listApps);
app.post("/", createApp);
app.get("/:packageName", getApp);
app.put("/:packageName", updateApp);
app.delete("/:packageName", deleteApp);
app.post("/:packageName/publish", publishApp);
app.post("/:packageName/api-key", regenerateApiKey);
app.post("/:packageName/move", moveApp);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/console/apps
 * List apps for the authenticated console user.
 * Optional query param: ?orgId= to filter by organization.
 */
async function listApps(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const orgId = c.req.query("orgId") || undefined;

    const mod = await import("../../../services/console/console.apps.service");
    const apps = await mod.listApps(email, { orgId });

    return c.json({ success: true, data: apps });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to list apps");
    return c.json(
      {
        error: e?.message || "Failed to list apps",
      },
      status,
    );
  }
}

/**
 * POST /api/console/apps
 * Create a new app.
 * Body may include orgId to associate with an organization.
 */
async function createApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const orgId = typeof body["orgId"] === "string" ? (body["orgId"] as string) : undefined;

    // Separate orgId from the rest of the app input
    const { orgId: _omit, ...appInput } = body;

    const mod = await import("../../../services/console/console.apps.service");
    const result = await mod.createApp(email, appInput, { orgId });

    return c.json({ success: true, data: result }, 201);
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to create app");
    return c.json(
      {
        error: e?.message || "Failed to create app",
      },
      status,
    );
  }
}

/**
 * GET /api/console/apps/:packageName
 * Get app details.
 */
async function getApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const mod = await import("../../../services/console/console.apps.service");
    const appData = await mod.getApp(email, packageName);

    return c.json({ success: true, data: appData });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to get app");
    return c.json(
      {
        error: e?.message || "Failed to get app",
      },
      status,
    );
  }
}

/**
 * PUT /api/console/apps/:packageName
 * Update app details.
 */
async function updateApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const data = await c.req.json().catch(() => ({}));

    const mod = await import("../../../services/console/console.apps.service");
    const appData = await mod.updateApp(email, packageName, data);

    return c.json({ success: true, data: appData });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to update app");
    return c.json(
      {
        error: e?.message || "Failed to update app",
      },
      status,
    );
  }
}

/**
 * DELETE /api/console/apps/:packageName
 * Delete an app.
 */
async function deleteApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const mod = await import("../../../services/console/console.apps.service");
    await mod.deleteApp(email, packageName);

    return c.json({ success: true, message: "App deleted" });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to delete app");
    return c.json(
      {
        error: e?.message || "Failed to delete app",
      },
      status,
    );
  }
}

/**
 * POST /api/console/apps/:packageName/publish
 * Publish an app to the store.
 */
async function publishApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const mod = await import("../../../services/console/console.apps.service");
    const appData = await mod.publishApp(email, packageName);

    return c.json({ success: true, data: appData });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to publish app");
    return c.json(
      {
        error: e?.message || "Failed to publish app",
      },
      status,
    );
  }
}

/**
 * POST /api/console/apps/:packageName/api-key
 * Regenerate the API key for an app.
 */
async function regenerateApiKey(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const mod = await import("../../../services/console/console.apps.service");
    const result = await mod.regenerateApiKey(email, packageName);

    return c.json({ success: true, data: result });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to regenerate API key");
    return c.json(
      {
        error: e?.message || "Failed to regenerate API key",
      },
      status,
    );
  }
}

/**
 * POST /api/console/apps/:packageName/move
 * Move an app to a different organization.
 * Body: { targetOrgId: string }
 */
async function moveApp(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      return c.json(
        {
          error: "Unauthorized",
          message: "Missing console email",
        },
        401,
      );
    }

    const packageName = c.req.param("packageName");
    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { targetOrgId } = body as { targetOrgId?: string };

    if (!targetOrgId || typeof targetOrgId !== "string") {
      return c.json({ error: "Missing targetOrgId" }, 400);
    }

    const mod = await import("../../../services/console/console.apps.service");
    const appData = await mod.moveApp(email, packageName, targetOrgId);

    return c.json({ success: true, data: appData });
  } catch (e: any) {
    const status = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    logger.error(e, "Failed to move app");
    return c.json(
      {
        error: e?.message || "Failed to move app",
      },
      status,
    );
  }
}

export default app;
