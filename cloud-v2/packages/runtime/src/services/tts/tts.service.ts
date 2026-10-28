/**
 * @fileoverview Runtime TTS service.
 *
 * The API layer owns HTTP/query validation. This service owns provider choice
 * and keeps the route independent from ElevenLabs-specific transport details.
 */
import { ElevenLabsTtsProvider } from "./providers/elevenlabs.provider";
import { DEFAULT_TTS_AUDIO_FORMAT, type TtsAudioFormat } from "./tts-formats";

export {
  DEFAULT_TTS_AUDIO_FORMAT,
  isTtsAudioFormat,
  TTS_AUDIO_FORMATS,
  type TtsAudioFormat,
} from "./tts-formats";

export interface TtsSpeakOptions {
  voiceId?: string;
  modelId?: string;
  voiceSettings?: Record<string, unknown>;
  format?: TtsAudioFormat;
}

export interface TtsProviderSpeakRequest extends TtsSpeakOptions {
  text: string;
}

export interface TtsProvider {
  preflight(format: TtsAudioFormat): Response;
  speak(req: TtsProviderSpeakRequest): Promise<Response>;
}

export class TtsService {
  constructor(private readonly provider: TtsProvider = new ElevenLabsTtsProvider()) {}

  preflight(format: TtsAudioFormat = DEFAULT_TTS_AUDIO_FORMAT): Response {
    return this.provider.preflight(format);
  }

  speak(text: string, options: TtsSpeakOptions = {}): Promise<Response> {
    return this.provider.speak({
      text,
      ...options,
    });
  }
}

export const ttsService = new TtsService();
