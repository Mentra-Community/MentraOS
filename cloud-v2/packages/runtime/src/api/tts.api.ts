/**
 * @fileoverview TTS service REST routes (Hono). Mounted at `/api/tts`.
 */
import { Hono, type Context } from "hono";
import { createLogger } from "@mentra/cloud-shared";
import {
  DEFAULT_TTS_AUDIO_FORMAT,
  isTtsAudioFormat,
  ttsService,
  type TtsAudioFormat,
} from "../services/tts/tts.service";

const logger = createLogger("tts").child({ service: "tts.api" });

export const ttsApi = new Hono();

type SpeakRequest =
  | {
      ok: true;
      text: string;
      voiceId?: string;
      modelId?: string;
      voiceSettings?: Record<string, unknown>;
      format: TtsAudioFormat;
    }
  | { ok: false; response: Response };

function parseSpeakRequest(c: Context): SpeakRequest {
  const text = c.req.query("text");
  const voiceId = c.req.query("voice_id");
  const modelId = c.req.query("model_id");
  const voiceSettingsRaw = c.req.query("voice_settings");
  const formatRaw = c.req.query("format") || DEFAULT_TTS_AUDIO_FORMAT;

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

  if (!isTtsAudioFormat(formatRaw)) {
    return {
      ok: false,
      response: c.json(
        {
          success: false,
          message: `Unsupported format: ${formatRaw}`,
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
    format: formatRaw,
  };
}

/**
 * GET /api/tts/speak
 *
 * Stream TTS audio for host playback. The cloud-client owns this endpoint
 * shape and preflights it before handing a source URL to the mobile player.
 * Hono dispatches HEAD through GET and strips the body, so branch here to keep
 * preflight from synthesizing audio.
 *
 * `format` selects the encoding: `mp3` (default) or `pcm_24000`, raw signed
 * 16-bit little-endian mono PCM at 24 kHz that the Mentra App streams into its
 * PCM player as it arrives.
 */
ttsApi.get("/speak", async (c) => {
  const parsed = parseSpeakRequest(c);
  if (!parsed.ok) return parsed.response;
  if (c.req.method === "HEAD") return ttsService.preflight(parsed.format);

  return ttsService.speak(parsed.text, {
    voiceId: parsed.voiceId,
    modelId: parsed.modelId,
    voiceSettings: parsed.voiceSettings,
    format: parsed.format,
  });
});
