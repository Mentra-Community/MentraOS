/**
 * @fileoverview Hono photo response API routes.
 * API endpoint for photo capture responses (success and error) from mobile clients.
 * Replaces the WebSocket-based photo_response path for reliability —
 * when things go wrong, the WebSocket might be the broken thing.
 *
 * Mounted at: /api/client/photo
 *
 * This handler validates the raw request body, builds a typed PhotoResponse,
 * and passes it to PhotoManager. No `any` flows downstream.
 *
 * See: cloud/issues/038-photo-error-rest-endpoint/spec.md
 */

import { Hono } from "hono";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { GlassesToCloudMessageType, PhotoErrorCode } from "@mentra/sdk";
import type { PhotoResponse } from "@mentra/sdk";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "photo.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/response", clientAuth, requireUserSession, handlePhotoResponse);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/photo/response
 *
 * Success body: { requestId, success: true, photoUrl, savedToGallery? }
 * Error body:   { requestId, success: false, errorCode?, errorMessage? }
 *
 * Validates the raw body, builds a typed PhotoResponse, then hands it
 * to PhotoManager. Nothing unvalidated reaches downstream code.
 */
async function handlePhotoResponse(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = await c.req.json().catch(() => ({}));

    // ---- requestId ----
    if (typeof body.requestId !== "string" || body.requestId.trim() === "") {
      return c.json(
        {
          success: false,
          message: "requestId is required and must be a non-empty string",
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // ---- success ----
    if (typeof body.success !== "boolean") {
      return c.json(
        { success: false, message: "success is required and must be a boolean", timestamp: new Date().toISOString() },
        400,
      );
    }

    // ---- Build a typed PhotoResponse ----
    let photoResponse: PhotoResponse;

    if (body.success) {
      // Success — photoUrl is required
      if (typeof body.photoUrl !== "string" || body.photoUrl.trim() === "") {
        return c.json(
          {
            success: false,
            message: "photoUrl is required for success responses",
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }

      photoResponse = {
        type: GlassesToCloudMessageType.PHOTO_RESPONSE,
        requestId: body.requestId,
        success: true,
        photoUrl: body.photoUrl,
        ...(typeof body.savedToGallery === "boolean" ? { savedToGallery: body.savedToGallery } : {}),
      };
    } else {
      // Error — be lenient, client may be in a crash path.
      // Accept flat errorCode/errorMessage or fall back to UNKNOWN_ERROR.
      const code = typeof body.errorCode === "string" ? body.errorCode : PhotoErrorCode.UNKNOWN_ERROR;
      const message = typeof body.errorMessage === "string" ? body.errorMessage : "Unknown error";

      photoResponse = {
        type: GlassesToCloudMessageType.PHOTO_RESPONSE,
        requestId: body.requestId,
        success: false,
        error: {
          code: code as PhotoErrorCode,
          message,
        },
      };
    }

    reqLogger.info(
      {
        requestId: photoResponse.requestId,
        success: photoResponse.success,
        errorCode: photoResponse.error?.code,
        userId: userSession.userId,
      },
      `Photo response received via REST: ${photoResponse.success ? "success" : `error (${photoResponse.error?.code})`}`,
    );

    await userSession.photoManager.handlePhotoResponse(photoResponse);

    return c.json({
      success: true,
      message: "Photo response processed",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error({ error, userId: userSession.userId }, "Failed to process photo response");

    return c.json(
      {
        success: false,
        message: "Failed to process photo response",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
