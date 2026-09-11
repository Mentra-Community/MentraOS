/**
 * @fileoverview Runtime TTS service.
 *
 * The API layer owns HTTP/query validation. This service owns provider choice
 * and keeps the route independent from ElevenLabs-specific transport details.
 */
import { ElevenLabsTtsProvider } from "./providers/elevenlabs.provider";

export interface TtsSpeakOptions {
  voiceId?: string;
  modelId?: string;
  voiceSettings?: Record<string, unknown>;
}

export interface TtsProviderSpeakRequest extends TtsSpeakOptions {
  text: string;
}

export interface TtsProvider {
  preflight(): Response;
  speak(req: TtsProviderSpeakRequest): Promise<Response>;
}

export class TtsService {
  constructor(private readonly provider: TtsProvider = new ElevenLabsTtsProvider()) {}

  preflight(): Response {
    return this.provider.preflight();
  }

  speak(text: string, options: TtsSpeakOptions = {}): Promise<Response> {
    return this.provider.speak({
      text,
      ...options,
    });
  }
}

export const ttsService = new TtsService();
