/**
 * @fileoverview Hono streams routes.
 * Managed stream restream output endpoints.
 * Mounted at: /api/streams
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import UserSession from "../../../services/session/UserSession";
import App, { AppI } from "../../../models/app.model";
import appService from "../../../services/core/app.service";
import { RestreamDestination } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "streams.routes" });

const app = new Hono<AppEnv>();

// Limits for outputs
const MAX_OUTPUTS_PER_STREAM = 10;
const MAX_OUTPUTS_PER_APP = 10;

// ============================================================================
// Routes
// ============================================================================

app.post("/:streamId/outputs", validateAppApiKey, addRestreamOutput);
app.delete("/:streamId/outputs/:outputId", validateAppApiKey, removeRestreamOutput);
app.get("/:streamId/outputs", validateAppApiKey, listRestreamOutputs);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to validate app API key.
 * Checks Authorization header (Bearer token) and validates against app database.
 * Requires packageName in query params, body, or route params.
 */
async function validateAppApiKey(c: AppContext, next: () => Promise<void>) {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!apiKey) {
    return c.json({ error: "API Key required" }, 401);
  }

  // Get packageName from query, body, or params
  const packageName =
    c.req.query("packageName") ||
    c.req.param("packageName") ||
    (await c.req
      .json()
      .then((b) => b.packageName)
      .catch(() => null));

  if (!packageName) {
    logger.warn("App API Key Middleware: Package name not provided for API key validation.");
    return c.json({ error: "Package name required for API key validation" }, 400);
  }

  try {
    // Find app by package name
    const appDoc = await App.findOne({ packageName }).lean();

    if (!appDoc) {
      logger.warn(`App API Key Middleware: App not found for package name: ${packageName}`);
      return c.json({ error: "Invalid API Key or Package Name" }, 401);
    }

    // Validate the provided API key against the stored hash
    const isValid = await appService.validateApiKey(packageName, apiKey);

    if (!isValid) {
      logger.warn(`App API Key Middleware: Invalid API Key for package ${packageName}`);
      return c.json({ error: "Invalid API Key" }, 401);
    }

    // Store app info in context for handlers
    (c as any).app = appDoc;
    logger.info(`App API Key Middleware: Authenticated App ${packageName}`);

    await next();
  } catch (error) {
    logger.error(error, "Error validating API key");
    return c.json({ error: "Authentication failed" }, 401);
  }
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/streams/:streamId/outputs
 * Add a restream output to an active managed stream.
 */
async function addRestreamOutput(c: AppContext) {
  const streamId = c.req.param("streamId");
  const appDoc = (c as any).app as AppI;
  const packageName = appDoc.packageName;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { url, name } = body as RestreamDestination;

    logger.info(
      {
        streamId,
        packageName,
        url,
        name,
      },
      "Adding restream output to managed stream",
    );

    // Validate input
    if (!url || typeof url !== "string") {
      return c.json(
        {
          error: "INVALID_URL",
          message: "URL is required and must be a string",
        },
        400,
      );
    }

    // Validate RTMP URL format
    if (!url.startsWith("rtmp://") && !url.startsWith("rtmps://")) {
      return c.json(
        {
          error: "INVALID_URL_FORMAT",
          message: "URL must start with rtmp:// or rtmps://",
        },
        400,
      );
    }

    // Find user session by app
    const userSessions = UserSession.getAllSessions();
    let targetUserSession = null;
    let targetStream = null;

    for (const session of userSessions) {
      if (session.appManager.isAppRunning(packageName)) {
        const stream = session.managedStreamingExtension.getStreamByStreamId(streamId);
        if (stream && stream.type === "managed") {
          targetUserSession = session;
          targetStream = stream;
          break;
        }
      }
    }

    if (!targetUserSession || !targetStream) {
      return c.json(
        {
          error: "STREAM_NOT_FOUND",
          message: "Managed stream not found or app is not a viewer",
        },
        404,
      );
    }

    // Check if app is a viewer of this stream
    if (!targetStream.activeViewers.has(packageName)) {
      return c.json(
        {
          error: "NOT_A_VIEWER",
          message: "App must be viewing the stream to add outputs",
        },
        403,
      );
    }

    // Add the output
    const result = await targetUserSession.managedStreamingExtension.addRestreamOutput(streamId, packageName, {
      url,
      name,
    });

    if (result.success) {
      return c.json({
        success: true,
        outputId: result.outputId,
        message: "Output added successfully",
      });
    } else {
      // Map internal errors to HTTP status codes
      const statusCode =
        result.error === "MAX_OUTPUTS_REACHED" || result.error === "MAX_APP_OUTPUTS_REACHED"
          ? 409
          : result.error === "DUPLICATE_URL"
            ? 409
            : result.error === "CLOUDFLARE_ERROR"
              ? 502
              : 400;

      return c.json(
        {
          error: result.error,
          message: result.message,
        },
        statusCode,
      );
    }
  } catch (error) {
    logger.error(
      {
        error,
        streamId,
        packageName,
      },
      "Error adding restream output",
    );

    return c.json(
      {
        error: "INTERNAL_ERROR",
        message: "Failed to add restream output",
      },
      500,
    );
  }
}

/**
 * DELETE /api/streams/:streamId/outputs/:outputId
 * Remove a restream output from an active managed stream.
 */
async function removeRestreamOutput(c: AppContext) {
  const streamId = c.req.param("streamId");
  const outputId = c.req.param("outputId");
  const appDoc = (c as any).app as AppI;
  const packageName = appDoc.packageName;

  logger.info(
    {
      streamId,
      outputId,
      packageName,
    },
    "Removing restream output from managed stream",
  );

  try {
    // Find user session by app
    const userSessions = UserSession.getAllSessions();
    let targetUserSession = null;
    let targetStream = null;

    for (const session of userSessions) {
      if (session.appManager.isAppRunning(packageName)) {
        const stream = session.managedStreamingExtension.getStreamByStreamId(streamId);
        if (stream && stream.type === "managed") {
          targetUserSession = session;
          targetStream = stream;
          break;
        }
      }
    }

    if (!targetUserSession || !targetStream) {
      return c.json(
        {
          error: "STREAM_NOT_FOUND",
          message: "Managed stream not found",
        },
        404,
      );
    }

    // Remove the output
    const result = await targetUserSession.managedStreamingExtension.removeRestreamOutput(
      streamId,
      outputId,
      packageName,
    );

    if (result.success) {
      return c.json({
        success: true,
        message: "Output removed successfully",
      });
    } else {
      const statusCode =
        result.error === "OUTPUT_NOT_FOUND"
          ? 404
          : result.error === "NOT_AUTHORIZED"
            ? 403
            : result.error === "CLOUDFLARE_ERROR"
              ? 502
              : 400;

      return c.json(
        {
          error: result.error,
          message: result.message,
        },
        statusCode,
      );
    }
  } catch (error) {
    logger.error(
      {
        error,
        streamId,
        outputId,
        packageName,
      },
      "Error removing restream output",
    );

    return c.json(
      {
        error: "INTERNAL_ERROR",
        message: "Failed to remove restream output",
      },
      500,
    );
  }
}

/**
 * GET /api/streams/:streamId/outputs
 * List all restream outputs for a managed stream.
 */
async function listRestreamOutputs(c: AppContext) {
  const streamId = c.req.param("streamId");
  const appDoc = (c as any).app as AppI;
  const packageName = appDoc.packageName;

  try {
    // Find user session by app
    const userSessions = UserSession.getAllSessions();
    let targetStream = null;

    for (const session of userSessions) {
      if (session.appManager.isAppRunning(packageName)) {
        const stream = session.managedStreamingExtension.getStreamByStreamId(streamId);
        if (stream && stream.type === "managed") {
          targetStream = stream;
          break;
        }
      }
    }

    if (!targetStream) {
      return c.json(
        {
          error: "STREAM_NOT_FOUND",
          message: "Managed stream not found",
        },
        404,
      );
    }

    // Check if app is a viewer of this stream
    if (!targetStream.activeViewers.has(packageName)) {
      return c.json(
        {
          error: "NOT_A_VIEWER",
          message: "App must be viewing the stream to list outputs",
        },
        403,
      );
    }

    // Format outputs for response
    const outputs =
      targetStream.outputs?.map((output: any) => ({
        outputId: output.cfOutputId,
        url: output.url,
        name: output.name,
        addedBy: output.addedBy,
        status: output.status?.status?.current?.state || "unknown",
        error: output.status?.status?.current?.lastError,
      })) || [];

    return c.json({
      streamId,
      outputs,
      total: outputs.length,
      maxPerStream: MAX_OUTPUTS_PER_STREAM,
      maxPerApp: MAX_OUTPUTS_PER_APP,
    });
  } catch (error) {
    logger.error(
      {
        error,
        streamId,
        packageName,
      },
      "Error listing restream outputs",
    );

    return c.json(
      {
        error: "INTERNAL_ERROR",
        message: "Failed to list restream outputs",
      },
      500,
    );
  }
}

export default app;
export { MAX_OUTPUTS_PER_STREAM, MAX_OUTPUTS_PER_APP };
