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

test("opt-in readiness caching reuses only the route check, not the spoken text", async () => {
  let heads = 0;
  const tts = new Tts({
    http: fakeHttp(async () => {
      heads++;
      return new Response(null, { headers: { "content-type": "audio/mpeg" } });
    }),
  });
  const first = await tts.speak("First answer", { reusePreflight: true });
  const second = await tts.speak("Second answer", { reusePreflight: true });
  expect(heads).toBe(1);
  expect(first.audioUrl).toContain("First+answer");
  expect(second.audioUrl).toContain("Second+answer");
  await tts.speak("Default behavior");
  expect(heads).toBe(2);
});

test("a different runtime endpoint requires a new readiness check", async () => {
  let heads = 0;
  let origin = "https://first.test";
  const http = fakeHttp(async () => {
    heads++;
    return new Response(null, { headers: { "content-type": "audio/mpeg" } });
  });
  http.url = (path) => origin + path;
  const tts = new Tts({ http });
  await tts.speak("First", { reusePreflight: true });
  origin = "https://second.test";
  const source = await tts.speak("Second", { reusePreflight: true });
  expect(heads).toBe(2);
  expect(source.audioUrl).toStartWith("https://second.test/");
});

test("pcm_24000 requests raw PCM and caches its readiness separately from MP3", async () => {
  const paths: string[] = [];
  const tts = new Tts({
    http: fakeHttp(async (path) => {
      paths.push(path);
      const pcm = path.includes("format=pcm_24000");
      return new Response(null, {
        headers: { "content-type": pcm ? "audio/pcm;encoding=s16le;rate=24000;channels=1" : "audio/mpeg" },
      });
    }),
  });
  const pcm = await tts.speak("Streamed", { format: "pcm_24000", reusePreflight: true });
  expect(pcm.audioUrl).toContain("format=pcm_24000");
  expect(pcm.contentType).toBe("audio/pcm;encoding=s16le;rate=24000;channels=1");
  await tts.speak("Streamed again", { format: "pcm_24000", reusePreflight: true });
  expect(paths).toHaveLength(1);
  const mp3 = await tts.speak("Clip", { reusePreflight: true });
  expect(paths).toHaveLength(2);
  expect(mp3.audioUrl).not.toContain("format=");
  expect(mp3.contentType).toBe("audio/mpeg");
});

test("refuses PCM from a runtime that answers MP3 for every format", async () => {
  const tts = new Tts({
    http: fakeHttp(async () => new Response(null, { headers: { "content-type": "audio/mpeg" } })),
  });
  await expect(tts.speak("Hello", { format: "pcm_24000" })).rejects.toThrow("does not support format pcm_24000");
});
