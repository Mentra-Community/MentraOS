/**
 * @fileoverview ElevenLabs streaming TTS provider.
 */
import { createLogger } from "@mentra/cloud-shared";
import { DEFAULT_TTS_AUDIO_FORMAT, TTS_AUDIO_FORMATS, type TtsAudioFormat } from "../tts-formats";
import type { TtsProvider, TtsProviderSpeakRequest } from "../tts.service";

const logger = createLogger("tts").child({ service: "elevenlabs.tts.provider" });

const ELEVENLABS_DEFAULTS = {
  voiceId: process.env.ELEVENLABS_DEFAULT_VOICE_ID || "8IRrZoKuYTPnpLc6lM6a",
  modelId: process.env.ELEVENLABS_DEFAULT_MODEL_ID || "eleven_flash_v2_5",
  speed: Number.parseFloat(process.env.ELEVENLABS_DEFAULT_SPEED || "1.13"),
  stability: Number.parseFloat(process.env.ELEVENLABS_DEFAULT_STABILITY || "0.68"),
  similarityBoost: Number.parseFloat(process.env.ELEVENLABS_DEFAULT_SIMILARITY || "0.75"),
  style: Number.parseFloat(process.env.ELEVENLABS_DEFAULT_STYLE || "0.0"),
};

/**
 * ElevenLabs `output_format` per runtime format. MP3 sends none, so the
 * request stays exactly what older hosts relied on (ElevenLabs' MP3 default).
 */
const ELEVENLABS_OUTPUT_FORMAT: Record<TtsAudioFormat, string | undefined> = {
  mp3: undefined,
  pcm_24000: "pcm_24000",
};

/** Exported for tests: the ElevenLabs streaming URL for a voice and format. */
export function elevenLabsStreamUrl(voiceId: string, format: TtsAudioFormat): string {
  const outputFormat = ELEVENLABS_OUTPUT_FORMAT[format];
  const base = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  return outputFormat ? `${base}?output_format=${outputFormat}` : base;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class ElevenLabsTtsProvider implements TtsProvider {
  preflight(format: TtsAudioFormat = DEFAULT_TTS_AUDIO_FORMAT): Response {
    if (!process.env.ELEVENLABS_API_KEY) {
      logger.error("ELEVENLABS_API_KEY environment variable not set");
      return json(
        {
          success: false,
          message: "TTS service not configured",
        },
        500,
      );
    }

    return new Response(null, {
      headers: {
        "Content-Type": TTS_AUDIO_FORMATS[format].contentType,
        "Cache-Control": "no-cache",
      },
    });
  }

  async speak(req: TtsProviderSpeakRequest): Promise<Response> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      logger.error("ELEVENLABS_API_KEY environment variable not set");
      return json(
        {
          success: false,
          message: "TTS service not configured",
        },
        500,
      );
    }

    const voiceId = req.voiceId || ELEVENLABS_DEFAULTS.voiceId;
    const modelId = req.modelId || ELEVENLABS_DEFAULTS.modelId;
    const voiceSettings = req.voiceSettings || {
      speed: ELEVENLABS_DEFAULTS.speed,
      stability: ELEVENLABS_DEFAULTS.stability,
      similarity_boost: ELEVENLABS_DEFAULTS.similarityBoost,
      style: ELEVENLABS_DEFAULTS.style,
    };
    const format = req.format ?? DEFAULT_TTS_AUDIO_FORMAT;
    const elevenLabsUrl = elevenLabsStreamUrl(voiceId, format);

    logger.info({ voiceId, modelId, format }, "streaming TTS request");

    const response = await fetch(elevenLabsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text: req.text,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, body: errorText }, "ElevenLabs TTS request failed");
      return json(
        {
          success: false,
          message: `TTS service error: ${response.status}`,
          details: errorText,
        },
        response.status,
      );
    }

    if (!response.body) {
      return json(
        {
          success: false,
          message: "No audio data received from TTS service",
        },
        500,
      );
    }

    // ElevenLabs relays PCM as it is synthesized; the body is raw samples with
    // no container, so the content type carries the sample format.
    return new Response(response.body, {
      headers: {
        "Content-Type": TTS_AUDIO_FORMATS[format].contentType,
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
