/**
 * Console CLI Keys API
 *
 * Base: /api/console/cli-keys
 *
 * Endpoints:
 * - POST   /                    → Generate new CLI API key
 * - GET    /                    → List user's CLI keys
 * - GET    /:keyId              → Get specific key details
 * - PATCH  /:keyId              → Update key (rename)
 * - DELETE /:keyId              → Revoke key
 *
 * Authentication: Console JWT (req.console.email)
 */

import { Router, Request, Response } from "express";
import { GenerateCLIKeyRequest, UpdateCLIKeyRequest } from "@mentra/types";
import * as cliKeysService from "../../services/console/cli-keys.service";
import { logger as rootLogger } from "../../services/logging/pino-logger";

const logger = rootLogger.child({ service: "cli-keys.api" });
const router = Router();

/**
 * Routes — declared first, handlers below (function declarations are hoisted)
 * NOTE: No per-route middleware - authenticateConsole applied at mount point
 */

// Generate new CLI key
router.post("/", generateKey);

// List user's CLI keys
router.get("/", listKeys);

// Get specific key
router.get("/:keyId", getKey);

// Update key (rename)
router.patch("/:keyId", updateKey);

// Revoke key
router.delete("/:keyId", revokeKey);

/**
 * Handlers
 */

async function generateKey(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      logger.warn("Generate key attempt without email");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body as GenerateCLIKeyRequest;
    const metadata = {
      createdFrom: req.ip,
      userAgent: req.headers["user-agent"],
    };

    logger.info({ email, keyName: body.name }, "Generating CLI key");
    const result = await cliKeysService.generateKey(email, body, metadata);
    logger.info(
      { email, keyId: result.keyId },
      "CLI key generated successfully",
    );
    return res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const contextLogger = logger.child({ email: req.console?.email });
    contextLogger.error(error, "Failed to generate CLI key");
    return res.status(400).json({ error: message });
  }
}

async function listKeys(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      logger.warn("List keys attempt without email");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const keys = await cliKeysService.listKeys(email);
    logger.debug({ email, count: keys.length }, "Listed CLI keys");
    return res.json({ success: true, data: keys });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const contextLogger = logger.child({ email: req.console?.email });
    contextLogger.error(error, "Failed to list CLI keys");
    return res.status(500).json({ error: message });
  }
}

async function getKey(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      logger.warn("Get key attempt without email");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { keyId } = req.params;
    const key = await cliKeysService.getKey(email, keyId);
    logger.debug({ email, keyId }, "Retrieved CLI key");
    return res.json({ success: true, data: key });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const contextLogger = logger.child({
      email: req.console?.email,
      keyId: req.params.keyId,
    });
    contextLogger.error(error, "Failed to get CLI key");
    return res.status(404).json({ error: message });
  }
}

async function updateKey(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      logger.warn("Update key attempt without email");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { keyId } = req.params;
    const body = req.body as UpdateCLIKeyRequest;
    logger.info({ email, keyId, newName: body.name }, "Updating CLI key");
    const result = await cliKeysService.updateKey(email, keyId, body.name);
    logger.info({ email, keyId }, "CLI key updated successfully");
    return res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const contextLogger = logger.child({
      email: req.console?.email,
      keyId: req.params.keyId,
    });
    contextLogger.error(error, "Failed to update CLI key");
    return res.status(400).json({ error: message });
  }
}

async function revokeKey(req: Request, res: Response) {
  try {
    const email = req.console?.email;
    if (!email) {
      logger.warn("Revoke key attempt without email");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { keyId } = req.params;
    logger.info({ email, keyId }, "Revoking CLI key");
    const result = await cliKeysService.revokeKey(email, keyId);
    logger.info({ email, keyId }, "CLI key revoked successfully");
    return res.json({ success: true, data: result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const contextLogger = logger.child({
      email: req.console?.email,
      keyId: req.params.keyId,
    });
    contextLogger.error(error, "Failed to revoke CLI key");
    return res.status(400).json({ error: message });
  }
}

export default router;
