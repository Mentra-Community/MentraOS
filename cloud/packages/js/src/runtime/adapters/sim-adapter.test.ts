/**
 * sim-adapter E2E sanity tests
 *
 * Proves that the MentraRuntime contract is implementable against
 * real `@mentra/client` + `@mentra/simulated-glasses` with no cloud,
 * no MiniAppServer, no mocks.
 *
 * Each test here is a mini demo of the salvage thesis: developer code
 * shaped around the contract runs end-to-end without the cloud runtime.
 */
import { describe, test, expect } from "bun:test";
import { MentraClient } from "@mentra/client";
import { SimulatedGlasses } from "@mentra/simulated-glasses";
import { SimAdapter } from "./sim-adapter";

function build() {
  const client = new MentraClient();
  const glasses = SimulatedGlasses.G1();
  const adapter = new SimAdapter({ client, glasses });
  return { client, glasses, adapter };
}

describe("SimAdapter", () => {
  test("exposes adapter identity", () => {
    const { adapter } = build();
    expect(adapter.name).toBe("sim");
  });

  test("onReady fires after start()", () => {
    const { adapter } = build();
    let info: any = null;
    adapter.onReady((i) => {
      info = i;
    });
    expect(info).toBeNull();
    adapter.start();
    expect(info).not.toBeNull();
    expect(info.userId).toBe("local-user");
    expect(info.sessionId).toMatch(/^sim-/);
  });

  test("display.showTextWall routes through to simulated glasses", () => {
    const { glasses, adapter } = build();
    adapter.start();
    adapter.display.showTextWall("hello");
    const history = (glasses as any).display.history as Array<any>;
    expect(history.length).toBeGreaterThanOrEqual(1);
    const last = history[history.length - 1];
    expect(last.type).toBe("text_wall");
    expect(last.payload.text).toBe("hello");
  });

  test("injected transcription fires handlers", () => {
    const { adapter } = build();
    adapter.start();
    const received: string[] = [];
    const finals: string[] = [];
    adapter.transcription.on((d) => received.push(d.text));
    adapter.transcription.onFinal((d) => finals.push(d.text));

    adapter.injectTranscription({ text: "interim", isFinal: false });
    adapter.injectTranscription({ text: "final!", isFinal: true });

    expect(received).toEqual(["interim", "final!"]);
    expect(finals).toEqual(["final!"]);
  });

  test("handlers registered before start() still fire", () => {
    const { adapter } = build();
    let readyCount = 0;
    adapter.onReady(() => {
      readyCount++;
    });
    adapter.start();
    expect(readyCount).toBe(1);
  });

  test("display throws if called before start()", () => {
    const { adapter } = build();
    expect(() => adapter.display.showTextWall("nope")).toThrow();
  });

  test("stop() fires onStopped and detaches glasses", () => {
    const { adapter, client } = build();
    adapter.start();
    let reason: string | undefined;
    adapter.onStopped((r) => {
      reason = r;
    });
    expect(client.glasses.connected).toBe(true);
    adapter.stop("test");
    expect(reason).toBe("test");
    expect(client.glasses.connected).toBe(false);
  });

  test("simulates the full test-glasses-app flow", () => {
    // This is the demo: the exact shape of developer code in
    // test-glasses-app/client/index.ts runs here with zero cloud.
    const { adapter, glasses } = build();
    const state: Record<string, any> = { transcript: "", isListening: false };

    // onReady → set listening, subscribe to transcription → showText + state.set
    adapter.onReady(() => {
      adapter.display.showTextWall("test-glasses-app ready!");
      adapter.transcription.on((data) => {
        state.transcript = data.text;
        adapter.display.showText(data.text);
      });
      state.isListening = true;
    });

    adapter.start();
    expect(state.isListening).toBe(true);

    adapter.injectTranscription({ text: "hello world", isFinal: true });
    expect(state.transcript).toBe("hello world");

    const history = (glasses as any).display.history as Array<any>;
    // Should have at least: initial text_wall + "hello world" text
    const texts = history.map((e) => e.payload.text).filter(Boolean);
    expect(texts).toContain("test-glasses-app ready!");
    expect(texts).toContain("hello world");
  });
});
