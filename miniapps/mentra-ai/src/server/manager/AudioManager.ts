import type { User } from "../session/User";

/**
 * Derive the cloud's HTTPS base URL from the SDK's server URL.
 *
 * The SDK's own getHttpsServerUrl() only strips a trailing `/app-ws`
 * suffix. Our cloud's WebSocket URL ends in `/ws/miniapp`, so the SDK
 * leaves that path on — producing `…/ws/miniapp/api/tts`, a 404 that
 * makes the glasses' player go idle. This strips ANY trailing WS path
 * so the TTS endpoint resolves to `…/api/tts`.
 */
function cloudHttpsBase(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  let url = rawUrl.replace(/^wss?:\/\//, "https://").replace(/^ws:\/\//, "http://");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  // Drop the WebSocket path — keep only protocol + host (+ port).
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * AudioManager — text-to-speech and audio control for a single user.
 */
export class AudioManager {
  constructor(private user: User) {}

  /**
   * Speak text aloud on the glasses.
   *
   * Does NOT use the SDK's session.audio.speak(), whose URL builder
   * (convertToHttps) mishandles our `/ws/miniapp` WebSocket path. We
   * build the correct `/api/tts` URL ourselves and play it directly.
   *
   * Returns the SDK's AudioPlayResult (success / error / duration).
   */
  async speak(text: string) {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");

    const base = cloudHttpsBase(session.getServerUrl?.());
    if (!base) {
      // Fall back to the SDK path rather than failing outright.
      console.warn("🔊 AudioManager.speak: could not derive cloud URL, falling back to SDK speak()");
      return session.audio.speak(text);
    }

    const ttsUrl = `${base}/api/tts?text=${encodeURIComponent(text)}`;
    console.log(`🔊 AudioManager.speak: playing TTS via ${base}/api/tts`);

    // trackId 2 = TTS track; stopOtherAudio cancels any current playback.
    return session.audio.playAudio({
      audioUrl: ttsUrl,
      trackId: 2,
      stopOtherAudio: true,
    });
  }

  /** Stop any currently playing audio */
  async stopAudio(): Promise<void> {
    const session = this.user.appSession;
    if (!session) throw new Error("No active glasses session");
    await session.audio.stopAudio();
  }
}
