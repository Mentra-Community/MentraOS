/**
 * @fileoverview Hono audio routes.
 * Audio streaming and TTS endpoints.
 * Mounted at: /api/audio
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import appService from "../../../services/core/app.service";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "audio.routes" });

const app = new Hono<AppEnv>();

// Only allow com.augmentos.shazam for audio access
const ALLOWED_PACKAGE = "com.augmentos.shazam";

// ============================================================================
// Routes
// ============================================================================

app.get("/:userId", shazamAuthMiddleware, getAudio);
app.get("/tts", textToSpeech);

// ============================================================================
// Middleware
// ============================================================================

/**
 * Middleware to authenticate Shazam app requests.
 * Validates API key, package name, and user ID.
 */
async function shazamAuthMiddleware(c: AppContext, next: () => Promise<void>) {
  const apiKey = c.req.query("apiKey");
  const packageName = c.req.query("packageName");
  const userId = c.req.query("userId");

  if (!apiKey || !packageName || !userId) {
    return c.json(
      {
        success: false,
        message: "Authentication required. Provide apiKey, packageName, and userId.",
      },
      401,
    );
  }

  if (packageName !== ALLOWED_PACKAGE) {
    return c.json(
      {
        success: false,
        message: "Unauthorized package name",
      },
      403,
    );
  }

  // Validate the API key for the specified package
  const isValid = await appService.validateApiKey(packageName, apiKey);

  if (!isValid) {
    return c.json(
      {
        success: false,
        message: "Invalid API key.",
      },
      401,
    );
  }

  // Store user info in context
  (c as any).userSession = { userId, minimal: true, apiKeyAuth: true };

  await next();
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/audio/:userId
 * Returns the last 10 seconds of audio for the session as a binary buffer.
 */
async function getAudio(c: AppContext) {
  try {
    const userId = c.req.param("userId");
    const userSession = UserSession.getById(userId);

    if (!userSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (!userSession.recentAudioBuffer || userSession.recentAudioBuffer.length === 0) {
      return c.json({ error: "No audio available" }, 404);
    }

    // Get audio buffers from the audio manager
    const buffers = userSession.audioManager.getRecentAudioBuffer().map((chunk) => Buffer.from(chunk.data));

    if (buffers.length === 0) {
      return c.json({ error: "No decodable audio available" }, 404);
    }

    const audioBuffer = Buffer.concat(buffers);

    return new Response(audioBuffer, {
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    logger.error(error, "Error fetching audio");
    return c.json({ error: "Error fetching audio" }, 500);
  }
}

/**
 * GET /api/audio/tts
 * Text-to-speech using ElevenLabs API.
 * Query params: text, voice_id, model_id, voice_settings
 */
async function textToSpeech(c: AppContext) {
  try {
    const text = c.req.query("text");
    const voiceIdParam = c.req.query("voice_id");
    const modelId = c.req.query("model_id");
    const voiceSettingsRaw = c.req.query("voice_settings");

    // Validate required parameters
    if (!text) {
      return c.json(
        {
          success: false,
          message: "Text parameter is required and must be a string",
        },
        400,
      );
    }

    // Get API key and default voice ID from environment
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID;

    if (!apiKey) {
      logger.error("ELEVENLABS_API_KEY environment variable not set");
      return c.json(
        {
          success: false,
          message: "TTS service not configured",
        },
        500,
      );
    }

    // Use provided voice_id or default from environment
    const voiceId = voiceIdParam || defaultVoiceId;

    if (!voiceId) {
      return c.json(
        {
          success: false,
          message: "Voice ID is required (either as parameter or ELEVENLABS_DEFAULT_VOICE_ID env var)",
        },
        400,
      );
    }

    // Parse voice_settings if provided
    let parsedVoiceSettings = null;
    if (voiceSettingsRaw) {
      try {
        parsedVoiceSettings = JSON.parse(voiceSettingsRaw);
      } catch (error) {
        logger.error(error, "Invalid voice_settings JSON format");
        return c.json(
          {
            success: false,
            message: "Invalid voice_settings JSON format",
          },
          400,
        );
      }
    }

    // Build request body for ElevenLabs API
    const requestBody: any = {
      text: text,
      model_id: modelId || "eleven_flash_v2_5",
    };

    if (parsedVoiceSettings) {
      requestBody.voice_settings = parsedVoiceSettings;
    }

    // Call ElevenLabs API
    const elevenLabsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

    logger.info(`Making TTS request to ElevenLabs for voice: ${voiceId}`);

    const response = await fetch(elevenLabsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      return c.json(
        {
          success: false,
          message: `TTS service error: ${response.status}`,
          details: errorText,
        },
        response.status as 400 | 401 | 403 | 404 | 500,
      );
    }

    // Stream the response back to the client
    if (response.body) {
      return new Response(response.body, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      return c.json(
        {
          success: false,
          message: "No audio data received from TTS service",
        },
        500,
      );
    }
  } catch (error) {
    logger.error(error, "Error in TTS route");
    return c.json(
      {
        success: false,
        message: "Internal server error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
}

export { textToSpeech };
export default app;
