/**
 * @fileoverview Runtime TTS API.
 *
 * The host owns the actual playback device (phone speaker / glasses audio
 * route), but the cloud-client owns the runtime endpoint, auth, and fast
 * validation. Callers receive a playable audio source only after the runtime
 * confirms the route exists and returns audio.
 */
import type { HttpClient } from "../../http";

const TTS_PATH = "/api/tts/speak";

export interface RuntimeTtsSpeakOptions {
  voiceId?: string;
  voice_id?: string;
  modelId?: string;
  model_id?: string;
  voiceSettings?: Record<string, unknown>;
  voice_settings?: Record<string, unknown>;
}

export interface RuntimeTtsSpeechSource {
  audioUrl: string;
  contentType: string;
  source: "cloud";
}

export interface TtsDeps {
  http: HttpClient;
}

export class Tts {
  private readonly http: HttpClient;

  constructor(deps: TtsDeps) {
    this.http = deps.http;
  }

  /**
   * Prepare cloud TTS for host playback.
   *
   * This intentionally returns an audio source rather than playing audio itself:
   * React Native and Node hosts have different playback devices. The important
   * boundary is that callers do not construct runtime URLs or discover 404s via
   * a media player timeout.
   */
  async speak(text: string, options: RuntimeTtsSpeakOptions = {}): Promise<RuntimeTtsSpeechSource> {
    if (!text.trim()) {
      throw new Error("runtime.tts.speak requires text");
    }

    const path = this.buildTtsPath(text, options);
    const res = await this.http.head(path, { idempotent: true });
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("audio/")) {
      throw new Error(`Runtime TTS returned non-audio content-type: ${contentType || "missing"}`);
    }

    return {
      audioUrl: this.http.url(path),
      contentType,
      source: "cloud",
    };
  }

  private buildTtsPath(text: string, options: RuntimeTtsSpeakOptions): string {
    const query = new URLSearchParams();
    query.set("text", text);

    const voiceId = options.voiceId ?? options.voice_id;
    if (voiceId) query.set("voice_id", voiceId);

    const modelId = options.modelId ?? options.model_id;
    if (modelId) query.set("model_id", modelId);

    const voiceSettings = options.voiceSettings ?? options.voice_settings;
    if (voiceSettings) query.set("voice_settings", JSON.stringify(voiceSettings));

    return `${TTS_PATH}?${query.toString()}`;
  }
}
