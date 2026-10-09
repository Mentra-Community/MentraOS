import {describe, expect, test} from "bun:test";
import {createRequire} from "node:module";
import {SonioxNodeClient} from "@soniox/node";

import {createSonioxProvider} from "./soniox";
import type {TranscriptEvent, TranscriptionProvider} from "./provider";

const require = createRequire(import.meta.url);
const clients: Array<[string, typeof SonioxNodeClient]> = [
  ["ESM", SonioxNodeClient],
  ["CommonJS", require("@soniox/node").SonioxNodeClient],
];

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Soniox session");
    await Bun.sleep(10);
  }
}

describe("Soniox connection authentication", () => {
  for (const [format, Client] of clients) {
    for (const targetLanguage of [undefined, "es"] as const) {
      test(`${format}: ${targetLanguage ? "translation" : "transcription"} authenticates initial and replacement sessions`, async () => {
        const apiKey = "soniox-auth-test-key";
        const connections: string[] = [];
        const configs: Array<Record<string, unknown>> = [];
        const events: TranscriptEvent[] = [];
        let upstream: Bun.ServerWebSocket<undefined> | undefined;
        let provider: TranscriptionProvider | undefined;
        const server = Bun.serve<undefined>({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            const protocols = request.headers.get("sec-websocket-protocol") ?? "";
            // Simulate the post-deadline service: refuse connections without
            // connection authentication, even if a later message has api_key.
            if (protocols.split(",").map((p) => p.trim()).join(",") !== `soniox-api-key,${apiKey}`) {
              return new Response("Unauthenticated", {status: 401});
            }
            connections.push(protocols);
            if (server.upgrade(request, {headers: {"Sec-WebSocket-Protocol": "soniox-api-key"}})) return;
            return new Response("Upgrade required", {status: 400});
          },
          websocket: {
            open(ws) {
              upstream = ws;
            },
            message(ws, message) {
              if (message === "") {
                ws.send(JSON.stringify({tokens: [], finished: true}));
              } else if (typeof message === "string") {
                const config = JSON.parse(message);
                if (config.model) configs.push(config);
              } else {
                ws.send(JSON.stringify({tokens: [
                  {text: targetLanguage ? "Hola" : "Hello", is_final: true, confidence: 1,
                    language: targetLanguage ?? "en",
                    ...(targetLanguage ? {translation_status: "translation"} : {})},
                  {text: "<end>", is_final: true, confidence: 1},
                ]}));
              }
            },
          },
        });
        try {
          provider = await createSonioxProvider({
            scope: "auth-test",
            language: "en",
            targetLanguage,
            client: new Client({api_key: apiKey, realtime: {
              ws_base_url: `ws://127.0.0.1:${server.port}`,
            }}),
            onTranscript: (event) => events.push(event),
          });
          await waitUntil(() => configs.length === 1);
          provider.writeAudio(new Int16Array(160));
          await waitUntil(() => events.some((event) => event.isFinal));
          upstream!.close(1011, "test reconnect");
          await waitUntil(() => configs.length === 2);
          const beforeReconnectAudio = events.length;
          provider.writeAudio(new Int16Array(160));
          await waitUntil(() => events.length > beforeReconnectAudio);

          expect(connections).toHaveLength(2);
          for (const config of configs) {
            expect(config).not.toHaveProperty("api_key");
            expect(config.model).toBe(process.env.SONIOX_MODEL ?? "stt-rt-v5");
            expect(config.audio_format).toBe("pcm_s16le");
            if (targetLanguage) {
              expect(config.translation).toEqual({type: "one_way", target_language: "es"});
            } else {
              expect(config).not.toHaveProperty("translation");
            }
          }
          expect(events.at(-1)?.text).toBe(targetLanguage ? "Hola" : "Hello");
        } finally {
          try {
            await provider?.close();
          } finally {
            server.stop(true);
          }
        }
      }, 15_000);
    }
  }
});
