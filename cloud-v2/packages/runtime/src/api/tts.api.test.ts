import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";

import { elevenLabsStreamUrl } from "../services/tts/providers/elevenlabs.provider";
import { ttsApi } from "./tts.api";

const PCM_CONTENT_TYPE = "audio/pcm;encoding=s16le;rate=24000;channels=1";

function app(): Hono {
  const root = new Hono();
  root.route("/api/tts", ttsApi);
  return root;
}

describe("runtime TTS formats", () => {
  const previousKey = process.env.ELEVENLABS_API_KEY;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  let requestedUrls: string[];

  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    requestedUrls = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 });
    }) as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousKey;
  });

  test("MP3 stays the default for preflight and speech", async () => {
    const head = await app().request("/api/tts/speak?text=Hi", { method: "HEAD" });
    expect(head.headers.get("content-type")).toBe("audio/mpeg");
    expect(requestedUrls).toEqual([]);

    const speech = await app().request("/api/tts/speak?text=Hi");
    expect(speech.headers.get("content-type")).toBe("audio/mpeg");
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).not.toContain("output_format");
  });

  test("pcm_24000 asks ElevenLabs for raw PCM and labels its sample format", async () => {
    const head = await app().request("/api/tts/speak?text=Hi&format=pcm_24000", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(PCM_CONTENT_TYPE);
    expect(requestedUrls).toEqual([]);

    const speech = await app().request("/api/tts/speak?text=Hi&format=pcm_24000");
    expect(speech.headers.get("content-type")).toBe(PCM_CONTENT_TYPE);
    expect(requestedUrls[0]).toEndWith("/stream?output_format=pcm_24000");
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(new Uint8Array([1, 0, 2, 0]));
  });

  test("rejects an unknown format before synthesizing", async () => {
    const response = await app().request("/api/tts/speak?text=Hi&format=opus_48000_32");
    expect(response.status).toBe(400);
    expect(requestedUrls).toEqual([]);
  });

  test("builds the stream URL per format", () => {
    expect(elevenLabsStreamUrl("voice", "mp3")).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice/stream",
    );
    expect(elevenLabsStreamUrl("voice", "pcm_24000")).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice/stream?output_format=pcm_24000",
    );
  });
});
