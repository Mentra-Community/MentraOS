/**
 * Console App API (Skeleton)
 *
 * Base: /api/console/apps
 *
 * Endpoints (mounted at /api/console/apps):
 * - GET    /                    -> list apps (optional ?orgId= filter)
 * - POST   /                    -> create app (body may include orgId)
 * - GET    /:packageName        -> get app detail
 * - PUT    /:packageName        -> update app
 * - DELETE /:packageName        -> delete app
 * - POST   /:packageName/publish     -> publish app
 * - POST   /:packageName/api-key      -> regenerate API key
 * - POST   /:packageName/move         -> move app (body: { targetOrgId })
 *
 /**
  * Conventions:
  * - One resource per file, default export a single router.
  * - Middleware applied at mount point (not per-route).
  * - Routes declared at the top; handler implementations below as function declarations (hoisted).
  */

import { Router, Request, Response } from "express";

const router = Router();

/**
 * Routes — declared first, handlers below (function declarations are hoisted)
 * NOTE: No per-route middleware - authenticateConsole applied at mount point
 */

// List apps (optional org filter via ?orgId=)
router.get("/", listApps);

// Create app (body may include orgId)
router.post("/", createApp);

// App detail
router.get("/:packageName", getApp);

// Update app
router.put("/:packageName", updateApp);

// Delete app
router.delete("/:packageName", deleteApp);

// Publish app
router.post("/:packageName/publish", publishApp);

// Regenerate API key
router.post("/:packageName/api-key", regenerateApiKey);

// Move app between orgs (body: { targetOrgId })
router.post("/:packageName/move", moveApp);

/**
 * Handlers — skeletons returning 501 (Not Implemented)
 * Replace with service-backed implementations (e.g., services/console/console.app.service).
 */

async function listApps(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const orgId =
      typeof req.query?.orgId === "string"
        ? (req.query.orgId as string)
        : undefined;

    const mod = await import("../../services/console/console.apps.service");
    const apps = await mod.listApps(email, { orgId });

    return res.json({ success: true, data: apps });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to list apps",
    });
  }
}

async function createApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const orgId =
      typeof body["orgId"] === "string" ? (body["orgId"] as string) : undefined;

    // Separate orgId from the rest of the app input
    const { orgId: _omit, ...appInput } = body;

    const mod = await import("../../services/console/console.apps.service");
    const result = await mod.createApp(email, appInput, {
      orgId,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to create app",
    });
  }
}

async function getApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }

    const mod = await import("../../services/console/console.apps.service");
    const app = await mod.getApp(email, packageName);

    return res.json({ success: true, data: app });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to get app",
    });
  }
}

async function updateApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }
    const data = req.body ?? {};

    const mod = await import("../../services/console/console.apps.service");
    const app = await mod.updateApp(email, packageName, data);

    return res.json({ success: true, data: app });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to update app",
    });
  }
}

async function deleteApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }

    const mod = await import("../../services/console/console.apps.service");
    await mod.deleteApp(email, packageName);

    return res.json({ success: true, message: "App deleted" });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to delete app",
    });
  }
}

async function publishApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }

    const mod = await import("../../services/console/console.apps.service");
    const app = await mod.publishApp(email, packageName);

    return res.json({ success: true, data: app });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to publish app",
    });
  }
}

async function regenerateApiKey(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }

    const mod = await import("../../services/console/console.apps.service");
    const result = await mod.regenerateApiKey(email, packageName);

    return res.json({ success: true, data: result });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to regenerate API key",
    });
  }
}

async function moveApp(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing console email",
      });
    }
    const { packageName } = req.params;
    const { targetOrgId } = req.body || {};
    if (!packageName) {
      return res.status(400).json({ error: "Missing packageName" });
    }
    if (!targetOrgId || typeof targetOrgId !== "string") {
      return res.status(400).json({ error: "Missing targetOrgId" });
    }

    const mod = await import("../../services/console/console.apps.service");
    const app = await mod.moveApp(email, packageName, targetOrgId);

    return res.json({ success: true, data: app });
  } catch (e: any) {
    const status =
      e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500;
    return res.status(status).json({
      error: e?.message || "Failed to move app",
    });
  }
}

export default router;
