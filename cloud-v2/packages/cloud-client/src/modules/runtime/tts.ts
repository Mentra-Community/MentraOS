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

/**
 * Audio encoding of the returned source. `mp3` (default) plays in a media
 * player. `pcm_24000` is raw signed 16-bit little-endian mono PCM at 24 kHz,
 * for hosts that stream it into a PCM player as it downloads.
 */
export type RuntimeTtsFormat = "mp3" | "pcm_24000";

/** Content-type prefix the runtime must return for each format. */
const FORMAT_CONTENT_TYPE: Record<RuntimeTtsFormat, string> = {
  mp3: "audio/",
  pcm_24000: "audio/pcm",
};

export interface RuntimeTtsSpeakOptions {
  /** Reuse a successful runtime readiness check for 30 seconds. */
  reusePreflight?: boolean;
  /** Audio encoding to request. Default `mp3`. */
  format?: RuntimeTtsFormat;
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
  private ready?: { endpoint: string; format: RuntimeTtsFormat; contentType: string; expiresAt: number };

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

    const format = options.format ?? "mp3";
    const path = this.buildTtsPath(text, options);
    const endpoint = this.http.url(TTS_PATH);
    let contentType: string;
    const ready = this.ready;
    if (
      options.reusePreflight &&
      ready?.endpoint === endpoint &&
      ready.format === format &&
      ready.expiresAt > Date.now()
    ) {
      contentType = ready.contentType;
    } else {
      const res = await this.http.head(path, { idempotent: true });
      contentType = res.headers.get("content-type") ?? "";
      const normalized = contentType.toLowerCase();
      if (!normalized.startsWith("audio/")) {
        throw new Error(`Runtime TTS returned non-audio content-type: ${contentType || "missing"}`);
      }
      // A runtime that predates `format` ignores it and answers MP3. Playing
      // those bytes as PCM would be noise, so refuse before playback.
      if (!normalized.startsWith(FORMAT_CONTENT_TYPE[format])) {
        throw new Error(`Runtime TTS does not support format ${format} (returned ${contentType})`);
      }
      if (options.reusePreflight) this.ready = { endpoint, format, contentType, expiresAt: Date.now() + 30_000 };
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

    // MP3 is the runtime default; leave its URL unchanged for older runtimes.
    if (options.format && options.format !== "mp3") query.set("format", options.format);

    return `${TTS_PATH}?${query.toString()}`;
  }
}
