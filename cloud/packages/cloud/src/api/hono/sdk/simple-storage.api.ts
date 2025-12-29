/**
 * @fileoverview Hono simple-storage API routes.
 * Provides key-value storage functionality for MentraOS Apps through REST API endpoints.
 * All routes are protected by SDK authentication middleware requiring valid package credentials.
 *
 * Storage is organized by userId (email) and packageName, creating isolated storage spaces
 * for each App-user combination. Data is persisted in MongoDB using the SimpleStorage model.
 *
 * Limits:
 * - Max value size: 100KB per value
 * - Max total storage: 1MB per (email, packageName)
 * - Rate limit: 100 requests/min per (email, packageName)
 *
 * Mounted at: /api/sdk/simple-storage
 */

import { Hono } from "hono";
import { authenticateSDK } from "../middleware/sdk.middleware";
import * as SimpleStorageService from "../../../services/sdk/simple-storage.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "simple-storage.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

// TODO: Add rate limiting middleware (100 req/min per user+package)
// app.use(simpleStorageRateLimit);

app.get("/:email", authenticateSDK, getAllHandler);
app.put("/:email", authenticateSDK, updateManyHandler);
app.delete("/:email", authenticateSDK, deleteAllHandler);

app.get("/:email/:key", authenticateSDK, getKeyHandler);
app.put("/:email/:key", authenticateSDK, setKeyHandler);
app.delete("/:email/:key", authenticateSDK, deleteKeyHandler);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/sdk/simple-storage/:email
 * Returns the entire key/value object for the authenticated package and the specified email.
 * Auth: Bearer <packageName>:<apiKey>
 */
async function getAllHandler(c: AppContext) {
  try {
    const email = String(c.req.param("email") || "").toLowerCase();
    const sdk = c.get("sdk");
    const packageName = sdk?.packageName;

    if (!email) {
      return c.json({ error: "Missing email parameter" }, 400);
    }
    if (!packageName) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const data = await SimpleStorageService.getAll(email, packageName);
    return c.json({ success: true, data });
  } catch (error) {
    logger.error(error, "GET /api/sdk/simple-storage/:email error");
    return c.json({ error: "Failed to get storage" }, 500);
  }
}

/**
 * PUT /api/sdk/simple-storage/:email
 * Upserts many key/value pairs for the authenticated package and user.
 * Body: { data: Record<string, string> }
 * Auth: Bearer <packageName>:<apiKey>
 */
async function updateManyHandler(c: AppContext) {
  try {
    const sdk = c.get("sdk");
    if (!sdk) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const email = String(c.req.param("email") || "").toLowerCase();
    const packageName = sdk.packageName;
    const body = await c.req.json().catch(() => ({}));
    const { data } = body as { data?: Record<string, string> };

    if (!email) {
      return c.json({ error: "Missing email parameter" }, 400);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return c.json(
        {
          error: "Invalid body: expected { data: Record<string,string> }",
        },
        400,
      );
    }

    const invalid = Object.entries(data).find(([, v]) => typeof v !== "string");
    if (invalid) {
      return c.json(
        {
          error: "All values must be strings",
          detail: `Invalid value for key "${invalid[0]}"`,
        },
        400,
      );
    }

    await SimpleStorageService.updateMany(email, packageName, data as Record<string, string>);

    return c.json({
      success: true,
      message: "Storage updated",
    });
  } catch (error) {
    logger.error(error, "PUT /api/sdk/simple-storage/:email error");

    const message = error instanceof Error ? error.message : "Failed to update storage";

    if (message.includes("exceeds 100KB limit")) {
      return c.json({ error: message }, 400);
    }
    if (message.includes("exceeds 1MB limit")) {
      return c.json({ error: message }, 413);
    }

    return c.json({ error: message }, 500);
  }
}

/**
 * DELETE /api/sdk/simple-storage/:email
 * Clears all key/value pairs for the authenticated package and user.
 * Auth: Bearer <packageName>:<apiKey>
 */
async function deleteAllHandler(c: AppContext) {
  try {
    const sdk = c.get("sdk");
    if (!sdk) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const email = String(c.req.param("email") || "").toLowerCase();
    const packageName = sdk.packageName;

    if (!email) {
      return c.json({ error: "Missing email parameter" }, 400);
    }

    const cleared = await SimpleStorageService.clearAll(email, packageName);
    if (!cleared) {
      return c.json(
        {
          success: false,
          message: "Storage not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: "Storage cleared",
    });
  } catch (error) {
    logger.error(error, "DELETE /api/sdk/simple-storage/:email error");
    return c.json({ error: "Failed to clear storage" }, 500);
  }
}

/**
 * GET /api/sdk/simple-storage/:email/:key
 * Returns a single string value for the specified key.
 * Auth: Bearer <packageName>:<apiKey>
 */
async function getKeyHandler(c: AppContext) {
  try {
    const sdk = c.get("sdk");
    if (!sdk) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const email = String(c.req.param("email") || "").toLowerCase();
    const key = String(c.req.param("key") || "");
    const packageName = sdk.packageName;

    if (!email || !key) {
      return c.json({ error: "Missing email or key parameter" }, 400);
    }

    const value = await SimpleStorageService.getKey(email, packageName, key);
    if (value === undefined) {
      return c.json(
        {
          success: false,
          message: "Key not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      data: { value },
    });
  } catch (error) {
    logger.error(error, "GET /api/sdk/simple-storage/:email/:key error");
    return c.json({ error: "Failed to get key" }, 500);
  }
}

/**
 * PUT /api/sdk/simple-storage/:email/:key
 * Sets a single string value for the specified key.
 * Body: { value: string }
 * Auth: Bearer <packageName>:<apiKey>
 */
async function setKeyHandler(c: AppContext) {
  try {
    const sdk = c.get("sdk");
    if (!sdk) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const email = String(c.req.param("email") || "").toLowerCase();
    const key = String(c.req.param("key") || "");
    const packageName = sdk.packageName;
    const body = await c.req.json().catch(() => ({}));
    const { value } = body as { value?: string };

    if (!email || !key) {
      return c.json({ error: "Missing email or key parameter" }, 400);
    }

    if (typeof value !== "string") {
      return c.json({ error: "Invalid body: expected { value: string }" }, 400);
    }

    await SimpleStorageService.setKey(email, packageName, key, value);
    return c.json({
      success: true,
      message: `Key "${key}" set`,
    });
  } catch (error) {
    logger.error(error, "PUT /api/sdk/simple-storage/:email/:key error");

    const message = error instanceof Error ? error.message : "Failed to set key";

    if (message.includes("exceeds 100KB limit")) {
      return c.json({ error: message }, 400);
    }
    if (message.includes("exceeds 1MB limit")) {
      return c.json({ error: message }, 413);
    }

    return c.json({ error: message }, 500);
  }
}

/**
 * DELETE /api/sdk/simple-storage/:email/:key
 * Deletes the specified key for the authenticated package and user.
 * Auth: Bearer <packageName>:<apiKey>
 */
async function deleteKeyHandler(c: AppContext) {
  try {
    const sdk = c.get("sdk");
    if (!sdk) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const email = String(c.req.param("email") || "").toLowerCase();
    const key = String(c.req.param("key") || "");
    const packageName = sdk.packageName;

    if (!email || !key) {
      return c.json({ error: "Missing email or key parameter" }, 400);
    }

    const deleted = await SimpleStorageService.deleteKey(email, packageName, key);
    if (!deleted) {
      return c.json(
        {
          success: false,
          message: "Storage not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: `Key "${key}" deleted`,
    });
  } catch (error) {
    logger.error(error, "DELETE /api/sdk/simple-storage/:email/:key error");
    return c.json({ error: "Failed to delete key" }, 500);
  }
}

export default app;
