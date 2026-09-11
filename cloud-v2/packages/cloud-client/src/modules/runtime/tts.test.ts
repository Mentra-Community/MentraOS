import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { Tts } from "./tts";

function fakeHttp(head: HttpClient["head"]): HttpClient {
  return {
    get: async () => undefined as never,
    head,
    post: async () => undefined as never,
    postForm: async () => undefined as never,
    put: async () => undefined as never,
    delete: async () => undefined as never,
    url: (path: string) => `https://runtime.test${path}`,
  };
}

describe("Runtime TTS", () => {
  test("preflights runtime TTS and returns a playable source URL", async () => {
    let seenPath = "";
    const tts = new Tts({
      http: fakeHttp(async (path) => {
        seenPath = path;
        return new Response(null, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }),
    });

    const source = await tts.speak("Hello from MentraJS", {
      voice_id: "voice-1",
      model_id: "model-1",
      voice_settings: { speed: 1.1 },
    });

    expect(seenPath).toStartWith("/api/tts/speak?");
    expect(seenPath).toContain("text=Hello+from+MentraJS");
    expect(seenPath).toContain("voice_id=voice-1");
    expect(seenPath).toContain("model_id=model-1");
    expect(source).toEqual({
      audioUrl: `https://runtime.test${seenPath}`,
      contentType: "audio/mpeg",
      source: "cloud",
    });
  });

  test("rejects a non-audio runtime response before playback", async () => {
    const tts = new Tts({
      http: fakeHttp(async () => {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    });

    await expect(tts.speak("Hello")).rejects.toThrow("non-audio content-type");
  });
});
