/**
 * @fileoverview Hono audio configuration API routes.
 * API endpoint for configuring audio format for client sessions.
 * Mounted at: /api/client/audio/configure
 *
 * This endpoint allows mobile clients to inform the cloud what audio format
 * they are sending (PCM or LC3). This enables the unified LC3 audio pipeline
 * where mobile encodes audio to LC3 before sending to cloud for bandwidth savings.
 */

import { Hono } from "hono";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";
import type { AudioFormat, LC3Config } from "../../../services/session/AudioManager";

const logger = rootLogger.child({ service: "audio-config.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Types
// ============================================================================

interface AudioConfigRequest {
  format: AudioFormat;
  lc3Config?: LC3Config;
}

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, configureAudio);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/audio/configure
 *
 * Configure the audio format for this session.
 * Must be called after WebSocket connection is established.
 *
 * Request body:
 * {
 *   "format": "lc3" | "pcm",
 *   "lc3Config"?: {
 *     "sampleRate": 16000,
 *     "frameDurationMs": 10,
 *     "frameSizeBytes": 20
 *   }
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "format": "lc3",
 *   "message": "Audio format configured successfully"
 * }
 */
async function configureAudio(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const body = (await c.req.json().catch(() => ({}))) as AudioConfigRequest;

    // Validate format
    if (!body.format || !["pcm", "lc3"].includes(body.format)) {
      return c.json(
        {
          success: false,
          message: 'Invalid format. Must be "pcm" or "lc3"',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Validate LC3 config if format is LC3
    if (body.format === "lc3") {
      if (!body.lc3Config) {
        // Use default canonical LC3 config
        body.lc3Config = {
          sampleRate: 16000,
          frameDurationMs: 10,
          frameSizeBytes: 20,
        };
      } else {
        // Validate provided config
        const { sampleRate, frameDurationMs, frameSizeBytes } = body.lc3Config;

        // Validate sample rate and frame duration (must be canonical)
        if (sampleRate !== 16000 || frameDurationMs !== 10) {
          reqLogger.warn(
            { lc3Config: body.lc3Config },
            "Non-canonical LC3 sampleRate/frameDurationMs, using defaults",
          );
          body.lc3Config.sampleRate = 16000;
          body.lc3Config.frameDurationMs = 10;
        }

        // Validate frame size (20, 40, or 60 bytes allowed)
        const validFrameSizes = [20, 40, 60];
        if (!validFrameSizes.includes(frameSizeBytes)) {
          reqLogger.warn(
            { frameSizeBytes, validFrameSizes },
            "Invalid LC3 frameSizeBytes, using default 20",
          );
          body.lc3Config.frameSizeBytes = 20;
        }
      }
    }

    reqLogger.info(
      {
        feature: "audio-config",
        format: body.format,
        lc3Config: body.lc3Config,
        userId: userSession.userId,
      },
      "Configuring audio format",
    );

    // Configure the audio format in AudioManager
    userSession.audioManager.setAudioFormat(body.format, body.lc3Config);

    return c.json({
      success: true,
      format: body.format,
      lc3Config: body.lc3Config,
      message: "Audio format configured successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error(
      { error, feature: "audio-config", userId: userSession.userId },
      "Failed to configure audio format",
    );
    return c.json(
      {
        success: false,
        message: "Failed to configure audio format",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
