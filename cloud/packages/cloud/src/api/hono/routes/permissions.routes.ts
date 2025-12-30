/**
 * @fileoverview Hono permissions routes.
 * Permission management endpoints for apps.
 * Mounted at: /api/permissions
 */

import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import App from "../../../models/app.model";
import { User } from "../../../models/user.model";
import { OrganizationService } from "../../../services/core/organization.service";
import { PermissionType } from "@mentra/sdk";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "permissions.routes" });

const app = new Hono<AppEnv>();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// ============================================================================
// Routes
// ============================================================================

app.get("/:packageName", validateCoreToken, getPermissions);
app.patch("/:packageName", validateCoreToken, updatePermissions);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate core token and extract user email and org context.
 */
async function validateCoreToken(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      return c.json({ error: "Invalid token data" }, 401);
    }

    c.set("email", decoded.email.toLowerCase());

    // Check for organization context in headers
    const orgIdHeader = c.req.header("x-org-id");
    if (orgIdHeader && typeof orgIdHeader === "string") {
      try {
        // Store org ID in a custom way since we can't add arbitrary properties
        (c as any).currentOrgId = new Types.ObjectId(orgIdHeader);
      } catch (e) {
        logger.debug({ orgIdHeader }, "Invalid org ID in header");
      }
    }

    await next();
  } catch (error) {
    logger.debug({ error }, "Token verification failed");
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/permissions/:packageName
 * Get permissions for an app.
 * Requires authentication.
 */
async function getPermissions(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    const userEmail = c.get("email");
    const currentOrgId = (c as any).currentOrgId as Types.ObjectId | undefined;

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Check if the organization owns this app or if the app is published
    let hasPermission = false;

    if (appDoc.appStoreStatus === "PUBLISHED") {
      hasPermission = true;
    } else if (currentOrgId && appDoc.organizationId) {
      hasPermission = appDoc.organizationId.toString() === currentOrgId.toString();
    } else if (appDoc.developerId === userEmail) {
      // For backward compatibility
      hasPermission = true;
    } else if (userEmail && appDoc.organizationId) {
      // Check if the user is in the org that owns the app
      const user = await User.findOne({ email: userEmail });
      if (user) {
        hasPermission = await OrganizationService.isOrgMember(user, appDoc.organizationId);
      }
    }

    if (!hasPermission) {
      logger.warn(`Unauthorized permission view attempt for ${packageName} by ${userEmail}`);
      return c.json(
        {
          error: "Unauthorized",
          message: "You do not have permission to view this app's permissions",
        },
        403,
      );
    }

    return c.json({ permissions: appDoc.permissions || [] });
  } catch (error) {
    logger.error(error, "Error fetching app permissions");
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * PATCH /api/permissions/:packageName
 * Update permissions for an app.
 * Requires authentication and organization ownership of the app.
 */
async function updatePermissions(c: AppContext) {
  try {
    const packageName = c.req.param("packageName");
    const userEmail = c.get("email");
    const currentOrgId = (c as any).currentOrgId as Types.ObjectId | undefined;

    if (!packageName) {
      return c.json({ error: "Missing packageName" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { permissions } = body as { permissions?: any[] };

    // Validate permissions
    if (!Array.isArray(permissions)) {
      return c.json({ error: "Permissions must be an array" }, 400);
    }

    // Verify app exists and the organization owns it
    const appDoc = await App.findOne({ packageName });

    if (!appDoc) {
      return c.json({ error: "App not found" }, 404);
    }

    // Check if the organization owns this app
    let hasPermission = false;

    if (currentOrgId && appDoc.organizationId) {
      hasPermission = appDoc.organizationId.toString() === currentOrgId.toString();
    } else if (appDoc.developerId === userEmail) {
      // For backward compatibility
      hasPermission = true;
    } else if (userEmail && appDoc.organizationId) {
      // Check if the user is in the org that owns the app
      const user = await User.findOne({ email: userEmail });
      if (user) {
        hasPermission = await OrganizationService.isOrgMember(user, appDoc.organizationId);
      }
    }

    if (!hasPermission) {
      logger.warn(`Unauthorized permission update attempt for ${packageName} by ${userEmail}`);
      return c.json(
        {
          error: "Unauthorized",
          message: "You do not have permission to modify this app",
        },
        403,
      );
    }

    // Validate each permission
    for (const perm of permissions) {
      if (!perm.type || !Object.values(PermissionType).includes(perm.type)) {
        return c.json({ error: `Invalid permission type: ${perm.type}` }, 400);
      }

      if (perm.description && typeof perm.description !== "string") {
        return c.json({ error: "Permission description must be a string" }, 400);
      }
    }

    // Update app permissions
    const updatedApp = await App.findOneAndUpdate({ packageName }, { $set: { permissions } }, { new: true });

    logger.info(`Updated permissions for app ${packageName} by developer ${userEmail}`);
    return c.json(updatedApp);
  } catch (error) {
    logger.error(error, "Error updating app permissions");
    return c.json({ error: "Internal server error" }, 500);
  }
}

export default app;
