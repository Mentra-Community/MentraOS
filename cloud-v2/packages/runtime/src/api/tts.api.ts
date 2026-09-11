/**
 * @fileoverview TTS service REST routes (Hono). Mounted at `/api/tts`.
 */
import { Hono, type Context } from "hono";
import { createLogger } from "@mentra/cloud-shared";
import { ttsService } from "../services/tts/tts.service";

const logger = createLogger("tts").child({ service: "tts.api" });

export const ttsApi = new Hono();

type SpeakRequest =
  | {
      ok: true;
      text: string;
      voiceId?: string;
      modelId?: string;
      voiceSettings?: Record<string, unknown>;
    }
  | { ok: false; response: Response };

function parseSpeakRequest(c: Context): SpeakRequest {
  const text = c.req.query("text");
  const voiceId = c.req.query("voice_id");
  const modelId = c.req.query("model_id");
  const voiceSettingsRaw = c.req.query("voice_settings");

  if (!text) {
    return {
      ok: false,
      response: c.json(
        {
          success: false,
          message: "Text parameter is required and must be a string",
        },
        400,
      ),
    };
  }

  let voiceSettings: Record<string, unknown> | undefined;
  if (voiceSettingsRaw) {
    try {
      voiceSettings = JSON.parse(voiceSettingsRaw) as Record<string, unknown>;
    } catch (error) {
      logger.error({ error }, "invalid voice_settings JSON format");
      return {
        ok: false,
        response: c.json(
          {
            success: false,
            message: "Invalid voice_settings JSON format",
          },
          400,
        ),
      };
    }
  }

  return {
    ok: true,
    text,
    voiceId,
    modelId,
    voiceSettings,
  };
}

/**
 * GET /api/tts/speak
 *
 * Stream TTS audio for host playback. The cloud-client owns this endpoint
 * shape and preflights it before handing a source URL to the mobile player.
 * Hono dispatches HEAD through GET and strips the body, so branch here to keep
 * preflight from synthesizing audio.
 */
ttsApi.get("/speak", async (c) => {
  const parsed = parseSpeakRequest(c);
  if (!parsed.ok) return parsed.response;
  if (c.req.method === "HEAD") return ttsService.preflight();

  return ttsService.speak(parsed.text, {
    voiceId: parsed.voiceId,
    modelId: parsed.modelId,
    voiceSettings: parsed.voiceSettings,
  });
});
