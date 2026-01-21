import express from "express";
import UserSession from "../services/session/UserSession";
import { Request, Response, NextFunction } from "express";
import appService from "../services/core/app.service";
import { logger as rootLogger } from "../services/logging/pino-logger";
const logger = rootLogger.child({ service: "audio.routes" });

const router = express.Router();

// ============================================================================
// ElevenLabs Default Voice Settings
// ============================================================================
// These are the hardcoded fallback defaults if environment variables aren't set
const ELEVENLABS_DEFAULTS = {
  VOICE_ID: "8IRrZoKuYTPnpLc6lM6a",
  SPEED: 1.13,
  STABILITY: 0.68,
  SIMILARITY_BOOST: 0.75,
  STYLE: 0.0,
};

/**
 * Get default voice settings from environment variables with hardcoded fallbacks
 */
function getDefaultVoiceSettings() {
  return {
    speed: parseFloat(process.env.ELEVENLABS_DEFAULT_SPEED || "") || ELEVENLABS_DEFAULTS.SPEED,
    stability: parseFloat(process.env.ELEVENLABS_DEFAULT_STABILITY || "") || ELEVENLABS_DEFAULTS.STABILITY,
    similarity_boost:
      parseFloat(process.env.ELEVENLABS_DEFAULT_SIMILARITY || "") || ELEVENLABS_DEFAULTS.SIMILARITY_BOOST,
    style: parseFloat(process.env.ELEVENLABS_DEFAULT_STYLE || "") ?? ELEVENLABS_DEFAULTS.STYLE,
  };
}

/**
 * Get default voice ID from environment variable with hardcoded fallback
 */
function getDefaultVoiceId() {
  return process.env.ELEVENLABS_DEFAULT_VOICE_ID || ELEVENLABS_DEFAULTS.VOICE_ID;
}

// Only allow com.augmentos.shazam
const ALLOWED_PACKAGE = "com.augmentos.shazam";

async function shazamAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.query.apiKey as string;
  const packageName = req.query.packageName as string;
  const userId = req.query.userId as string;

  if (apiKey && packageName && userId) {
    if (packageName !== ALLOWED_PACKAGE) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized package name",
      });
    }
    // Validate the API key for the specified package
    const isValid = await appService.validateApiKey(packageName, apiKey);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid API key.",
      });
    }
    (req as any).userSession = { userId, minimal: true, apiKeyAuth: true };
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Authentication required. Provide apiKey, packageName, and userId.",
  });
}

// TODO(isaiah): Improve audio manager to handle logic for getting the last 10 seconds of audio and decoding it if necessary.
// GET /api/audio/:sessionId
// Returns the last 10 seconds of audio for the session as a binary buffer (decoded to PCM if LC3)
router.get("/api/audio/:userId", shazamAuthMiddleware, async (req, res) => {
  try {
    const userId = req.params.userId;
    const userSession = UserSession.getById(userId);

    if (!userSession) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (!userSession.recentAudioBuffer || userSession.recentAudioBuffer.length === 0) {
      return res.status(404).json({ error: "No audio available" });
    }

    let buffers: Buffer[] = [];
    // The code below will may cause issues with the LC3 decoding, so it is commented out for now because we are not using LC3 yet.
    // if (IS_LC3 && userSession.audioManager.lc3Service) {
    //   // Decode each chunk to PCM
    //   for (const chunk of userSession.recentAudioBuffer) {
    //     try {
    //       // decodeAudioChunk may be async
    //       const decoded = await userSession.lc3Service.decodeAudioChunk(chunk.data);
    //       if (decoded) {
    //         buffers.push(Buffer.from(decoded));
    //       }
    //     } catch (err) {
    //       logger.error('Error decoding LC3 chunk:', err);
    //     }
    //   }
    // } else {
    //   // Not LC3, just use the raw data
    //   buffers = userSession.recentAudioBuffer.map(chunk => Buffer.from(chunk.data));
    // }

    buffers = userSession.audioManager.getRecentAudioBuffer().map((chunk) => Buffer.from(chunk.data));

    if (buffers.length === 0) {
      return res.status(404).json({ error: "No decodable audio available" });
    }
    const audioBuffer = Buffer.concat(buffers);
    res.set("Content-Type", "application/octet-stream");
    res.send(audioBuffer);
  } catch (error) {
    logger.error(error as Error, "Error fetching audio:");
    res.status(500).json({ error: "Error fetching audio" });
  }
});

// Add TTS route that calls ElevenLabs API and streams response
router.get("/api/tts", async (req, res) => {
  try {
    const { text, voice_id, model_id, voice_settings } = req.query;

    // Validate required parameters
    if (!text || typeof text !== "string") {
      return res.status(400).json({
        success: false,
        message: "Text parameter is required and must be a string",
      });
    }

    // Get API key from environment
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      logger.error("ELEVENLABS_API_KEY environment variable not set");
      return res.status(500).json({
        success: false,
        message: "TTS service not configured",
      });
    }

    // Use provided voice_id or default (env var with hardcoded fallback)
    const voiceId = (voice_id as string) || getDefaultVoiceId();

    // Parse voice_settings if provided
    let parsedVoiceSettings = null;
    if (voice_settings && typeof voice_settings === "string") {
      try {
        parsedVoiceSettings = JSON.parse(voice_settings);
      } catch (error) {
        logger.error(error, `Invalid voice_settings JSON format`);
        return res.status(400).json({
          success: false,
          message: "Invalid voice_settings JSON format",
        });
      }
    }

    // Build request body for ElevenLabs API
    const requestBody: any = {
      text: text,
    };

    if (model_id && typeof model_id === "string") {
      requestBody.model_id = model_id;
    } else {
      requestBody.model_id = "eleven_flash_v2_5";
    }

    // Use provided voice_settings or apply defaults (env vars with hardcoded fallbacks)
    if (parsedVoiceSettings) {
      requestBody.voice_settings = parsedVoiceSettings;
    } else {
      // Apply default voice settings when none provided
      requestBody.voice_settings = getDefaultVoiceSettings();
      logger.info({ voiceSettings: requestBody.voice_settings }, "Using default voice settings");
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
      return res.status(response.status).json({
        success: false,
        message: `TTS service error: ${response.status}`,
        details: errorText,
      });
    }

    // Set appropriate headers for audio streaming
    res.set({
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Stream the response back to the client
    if (response.body) {
      const reader = response.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          res.write(Buffer.from(value));
        }
        res.end();
      } catch (streamError) {
        logger.error(streamError as Error, "Error streaming audio:");
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming audio" });
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      res.status(500).json({
        success: false,
        message: "No audio data received from TTS service",
      });
    }
  } catch (error) {
    logger.error(error as Error, "Error in TTS route:");
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

export default router;
