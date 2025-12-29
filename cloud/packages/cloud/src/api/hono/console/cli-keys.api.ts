/**
 * @fileoverview Hono console CLI keys API routes.
 * Console CLI key management endpoints for authenticated console users.
 * Mounted at: /api/console/cli-keys
 */

import { Hono } from "hono";
import { GenerateCLIKeyRequest, UpdateCLIKeyRequest } from "@mentra/types";
import * as cliKeysService from "../../../services/console/cli-keys.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "console.cli-keys.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", generateKey);
app.get("/", listKeys);
app.get("/:keyId", getKey);
app.patch("/:keyId", updateKey);
app.delete("/:keyId", revokeKey);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/console/cli-keys
 * Generate a new CLI API key.
 */
async function generateKey(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      logger.warn("Generate key attempt without email");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = (await c.req.json().catch(() => ({}))) as GenerateCLIKeyRequest;
    const metadata = {
      createdFrom: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown",
      userAgent: c.req.header("user-agent"),
    };

    logger.info({ email, keyName: body.name }, "Generating CLI key");
    const result = await cliKeysService.generateKey(email, body, metadata);
    logger.info({ email, keyId: result.keyId }, "CLI key generated successfully");

    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(error, "Failed to generate CLI key");
    return c.json({ error: message }, 400);
  }
}

/**
 * GET /api/console/cli-keys
 * List all CLI keys for the authenticated user.
 */
async function listKeys(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      logger.warn("List keys attempt without email");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const keys = await cliKeysService.listKeys(email);
    logger.debug({ email, count: keys.length }, "Listed CLI keys");

    return c.json({ success: true, data: keys });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(error, "Failed to list CLI keys");
    return c.json({ error: message }, 500);
  }
}

/**
 * GET /api/console/cli-keys/:keyId
 * Get details of a specific CLI key.
 */
async function getKey(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      logger.warn("Get key attempt without email");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const keyId = c.req.param("keyId");
    if (!keyId) {
      return c.json({ error: "Missing keyId" }, 400);
    }

    const key = await cliKeysService.getKey(email, keyId);
    logger.debug({ email, keyId }, "Retrieved CLI key");

    return c.json({ success: true, data: key });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(error, "Failed to get CLI key");
    return c.json({ error: message }, 404);
  }
}

/**
 * PATCH /api/console/cli-keys/:keyId
 * Update a CLI key (rename).
 */
async function updateKey(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      logger.warn("Update key attempt without email");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const keyId = c.req.param("keyId");
    if (!keyId) {
      return c.json({ error: "Missing keyId" }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as UpdateCLIKeyRequest;

    logger.info({ email, keyId, newName: body.name }, "Updating CLI key");
    const result = await cliKeysService.updateKey(email, keyId, body.name);
    logger.info({ email, keyId }, "CLI key updated successfully");

    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(error, "Failed to update CLI key");
    return c.json({ error: message }, 400);
  }
}

/**
 * DELETE /api/console/cli-keys/:keyId
 * Revoke a CLI key.
 */
async function revokeKey(c: AppContext) {
  try {
    const consoleAuth = c.get("console");
    const email = consoleAuth?.email;

    if (!email) {
      logger.warn("Revoke key attempt without email");
      return c.json({ error: "Unauthorized" }, 401);
    }

    const keyId = c.req.param("keyId");
    if (!keyId) {
      return c.json({ error: "Missing keyId" }, 400);
    }

    logger.info({ email, keyId }, "Revoking CLI key");
    const result = await cliKeysService.revokeKey(email, keyId);
    logger.info({ email, keyId }, "CLI key revoked successfully");

    return c.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error(error, "Failed to revoke CLI key");
    return c.json({ error: message }, 400);
  }
}

export default app;
