import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MentraClient } from "@mentra/client";
import { SimulatedGlasses } from "./SimulatedGlasses";

describe("@mentra/client + @mentra/simulated-glasses E2E", () => {
  let client: MentraClient;
  let sim: SimulatedGlasses;

  beforeEach(async () => {
    client = new MentraClient({ token: "test-token" });
    await client.connect();
  });

  afterEach(() => {
    client.destroy();
    sim?.destroy();
  });

  // ── Glasses Attach ──────────────────────────────────────────

  describe("glasses.attach()", () => {
    test("G1 reports correct capabilities", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      expect(client.glasses.connected).toBe(true);
      expect(client.glasses.model).toBe("g1");
      expect(client.glasses.capabilities.hasDisplay).toBe(true);
      expect(client.glasses.capabilities.hasCamera).toBe(false);
      expect(client.glasses.capabilities.hasMic).toBe(true);
    });

    test("MentraLive reports correct capabilities", () => {
      sim = SimulatedGlasses.MentraLive();
      client.glasses.attach(sim);

      expect(client.glasses.model).toBe("mentra-live");
      expect(client.glasses.capabilities.hasDisplay).toBe(false);
      expect(client.glasses.capabilities.hasCamera).toBe(true);
      expect(client.glasses.capabilities.hasSpeaker).toBe(true);
      expect(client.glasses.capabilities.hasLight).toBe(true);
    });

    test("detach resets state", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);
      expect(client.glasses.connected).toBe(true);

      client.glasses.detach();
      expect(client.glasses.connected).toBe(false);
      expect(client.glasses.model).toBeNull();
    });

    test("attaching new glasses detaches previous", () => {
      const g1 = SimulatedGlasses.G1();
      const live = SimulatedGlasses.MentraLive();

      client.glasses.attach(g1);
      expect(client.glasses.model).toBe("g1");

      client.glasses.attach(live);
      expect(client.glasses.model).toBe("mentra-live");
    });
  });

  // ── Capability Gating ───────────────────────────────────────

  describe("capability gating", () => {
    test("G1 display works", () => {
      sim = SimulatedGlasses.G1();
      expect(() => sim.display.showText("hello")).not.toThrow();
      expect(sim.display.last?.payload.text).toBe("hello");
    });

    test("MentraLive display throws", () => {
      sim = SimulatedGlasses.MentraLive();
      expect(() => sim.display.showText("hello")).toThrow(/not available/);
    });

    test("G1 camera throws", () => {
      sim = SimulatedGlasses.G1();
      expect(sim.camera.takePhoto()).rejects.toThrow(/not available/);
    });

    test("MentraLive camera works", async () => {
      sim = SimulatedGlasses.MentraLive();
      const photo = await sim.camera.takePhoto();
      expect(photo.mimeType).toBe("image/jpeg");
    });

    test("G1 LED throws", () => {
      sim = SimulatedGlasses.G1();
      expect(() => sim.led.set({ color: "#FF0000" })).toThrow(/not available/);
    });

    test("MentraLive LED works", () => {
      sim = SimulatedGlasses.MentraLive();
      sim.led.set({ color: "#FF0000" });
      expect(sim.led.state.on).toBe(true);
      expect(sim.led.state.color).toBe("#FF0000");
    });
  });

  // ── Display Events Flow ─────────────────────────────────────

  describe("display event flow", () => {
    test("injected display event routes to attached glasses", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      client.injectDisplayEvent({
        type: "text_wall",
        view: "main",
        packageName: "com.example.test",
        payload: { text: "hello from app" },
      });

      expect(sim.display.last?.payload.text).toBe("hello from app");
      expect(sim.display.history).toHaveLength(1);
    });

    test("display events don't route to glasses without display", () => {
      sim = SimulatedGlasses.MentraLive();
      client.glasses.attach(sim);

      // Should not throw — the manager silently skips if no display
      client.injectDisplayEvent({
        type: "text_wall",
        view: "main",
        packageName: "com.example.test",
        payload: { text: "hello" },
      });

      // Display history is empty because MentraLive has no display
      expect(sim.display.history).toHaveLength(0);
    });

    test("display.waitFor() resolves on next event", async () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      const promise = sim.display.waitFor({ timeout: 2000 });

      // Inject an event after a small delay
      setTimeout(() => {
        client.injectDisplayEvent({
          type: "text_wall",
          view: "main",
          packageName: "com.example.test",
          payload: { text: "waited for this" },
        });
      }, 50);

      const event = await promise;
      expect(event.payload.text).toBe("waited for this");
    });

    test("display.waitFor() rejects on timeout", async () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      // No event will be sent — should timeout
      await expect(sim.display.waitFor({ timeout: 100 })).rejects.toThrow(
        /timed out/,
      );
    });
  });

  // ── Transcription Flow ──────────────────────────────────────

  describe("transcription", () => {
    test("injected transcription fires event", () => {
      const received: string[] = [];
      client.transcription.on((event) => received.push(event.text));

      client.injectTranscription({ text: "hello world", isFinal: false });
      client.injectTranscription({ text: "hello world!", isFinal: true });

      expect(received).toEqual(["hello world", "hello world!"]);
      expect(client.transcription.latest?.text).toBe("hello world!");
      expect(client.transcription.latest?.isFinal).toBe(true);
    });

    test("onFinal only fires for final results", () => {
      const finals: string[] = [];
      client.transcription.onFinal((event) => finals.push(event.text));

      client.injectTranscription({ text: "partial", isFinal: false });
      client.injectTranscription({ text: "final", isFinal: true });
      client.injectTranscription({ text: "another partial", isFinal: false });

      expect(finals).toEqual(["final"]);
    });

    test("unsubscribe works", () => {
      const received: string[] = [];
      const unsub = client.transcription.on((e) => received.push(e.text));

      client.injectTranscription({ text: "first", isFinal: true });
      unsub();
      client.injectTranscription({ text: "second", isFinal: true });

      expect(received).toEqual(["first"]);
    });
  });

  // ── Hardware Events (glasses → client) ──────────────────────

  describe("hardware events via attach", () => {
    test("button press flows from glasses to client", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      const buttons: string[] = [];
      client.glasses.on("button", (e) => buttons.push(e.buttonId));

      sim.device.pressButton("main");
      sim.device.pressButton("side", "long");

      expect(buttons).toEqual(["main", "side"]);
    });

    test("touch events flow from glasses to client", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      const touches: string[] = [];
      client.glasses.on("touch", (e) => touches.push(e.type));

      sim.device.touch("tap");
      sim.device.touch("swipe_forward");

      expect(touches).toEqual(["tap", "swipe_forward"]);
    });

    test("battery updates flow from glasses to client", () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      expect(client.glasses.batteryLevel).toBe(85); // default

      sim.device.setBattery(42, true);

      expect(client.glasses.batteryLevel).toBe(42);
      expect(client.glasses.charging).toBe(true);
    });

    test("mic chunks flow from glasses to client", () => {
      sim = SimulatedGlasses.MentraLive();
      client.glasses.attach(sim);

      const chunks: Uint8Array[] = [];
      client.glasses.on("mic_data", (pcm) => chunks.push(pcm));

      const testData = new Uint8Array([1, 2, 3, 4]);
      sim.mic.playBuffer(testData);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(testData);
    });
  });

  // ── App Manager ─────────────────────────────────────────────

  describe("app manager", () => {
    test("start and stop apps", async () => {
      client.apps.updateInstalledApps([
        {
          packageName: "com.example.captions",
          name: "Captions",
          running: false,
          loading: false,
          healthy: true,
          local: true,
          compatible: true,
          type: "standard",
        },
      ]);

      expect(client.apps.installed).toHaveLength(1);
      expect(client.apps.running).toHaveLength(0);

      await client.apps.start("com.example.captions");
      expect(client.apps.running).toHaveLength(1);
      expect(client.apps.running[0].packageName).toBe("com.example.captions");

      await client.apps.stop("com.example.captions");
      expect(client.apps.running).toHaveLength(0);
    });

    test("emits changed events", async () => {
      let changeCount = 0;
      client.apps.on("changed", () => changeCount++);

      client.apps.updateInstalledApps([
        {
          packageName: "com.example.test",
          name: "Test",
          running: false,
          loading: false,
          healthy: true,
          local: true,
          compatible: true,
          type: "standard",
        },
      ]);

      await client.apps.start("com.example.test");
      await client.apps.stop("com.example.test");

      // updateInstalledApps + start + stop = 3 changed events
      expect(changeCount).toBe(3);
    });
  });

  // ── Connection Manager ──────────────────────────────────────

  describe("connection", () => {
    test("connected after connect()", () => {
      expect(client.connected).toBe(true);
      expect(client.connection.status).toBe("connected");
      expect(client.sessionId).not.toBeNull();
    });

    test("disconnected after disconnect()", async () => {
      await client.disconnect();
      expect(client.connected).toBe(false);
      expect(client.connection.status).toBe("disconnected");
    });

    test("emits status events", async () => {
      const statuses: string[] = [];
      client.connection.on("status_changed", (s) => statuses.push(s));

      await client.disconnect();

      expect(statuses).toContain("disconnected");
    });
  });

  // ── Display Manager ─────────────────────────────────────────

  describe("display manager", () => {
    test("tracks main and dashboard events separately", () => {
      client.injectDisplayEvent({
        type: "text_wall",
        view: "main",
        packageName: "com.example.test",
        payload: { text: "main content" },
      });

      client.injectDisplayEvent({
        type: "dashboard_card",
        view: "dashboard",
        packageName: "com.example.test",
        payload: { text: "dashboard content" },
      });

      expect(client.display.mainEvent?.payload.text).toBe("main content");
      expect(client.display.dashboardEvent?.payload.text).toBe(
        "dashboard content",
      );
      expect(client.display.activeView).toBe("main");
      expect(client.display.currentEvent?.payload.text).toBe("main content");
    });

    test("switching view changes currentEvent", () => {
      client.injectDisplayEvent({
        type: "text_wall",
        view: "main",
        packageName: "com.example.test",
        payload: { text: "main" },
      });

      client.injectDisplayEvent({
        type: "text_wall",
        view: "dashboard",
        packageName: "com.example.test",
        payload: { text: "dashboard" },
      });

      client.display.setActiveView("dashboard");
      expect(client.display.currentEvent?.payload.text).toBe("dashboard");

      client.display.setActiveView("main");
      expect(client.display.currentEvent?.payload.text).toBe("main");
    });
  });

  // ── Custom Glasses Profile ──────────────────────────────────

  describe("custom glasses profile", () => {
    test("OEM can define custom capabilities", () => {
      sim = SimulatedGlasses.custom({
        modelId: "acme-pro",
        displayName: "Acme Pro",
        capabilities: {
          hasDisplay: true,
          hasCamera: true,
          hasMic: true,
          hasSpeaker: false,
          hasLight: false,
          hasButtons: true,
          hasTouchpad: false,
          hasWifi: true,
        },
      });

      client.glasses.attach(sim);

      expect(client.glasses.model).toBe("acme-pro");
      expect(client.glasses.capabilities.hasDisplay).toBe(true);
      expect(client.glasses.capabilities.hasCamera).toBe(true);
      expect(client.glasses.capabilities.hasSpeaker).toBe(false);

      // Display works
      sim.display.showText("hello from acme");
      expect(sim.display.last?.payload.text).toBe("hello from acme");

      // Camera works
      expect(sim.camera.takePhoto()).resolves.toBeDefined();

      // LED throws (not available)
      expect(() => sim.led.set({ color: "#FF0000" })).toThrow(/not available/);
    });
  });

  // ── Full Flow: Transcription → Display on Glasses ───────────

  describe("full flow", () => {
    test("transcription → app display → glasses", async () => {
      sim = SimulatedGlasses.G1();
      client.glasses.attach(sim);

      // Simulate what a mini app would do:
      // 1. Subscribe to transcription
      // 2. When text arrives, send a display event
      client.transcription.on((event) => {
        client.injectDisplayEvent({
          type: "text_wall",
          view: "main",
          packageName: "com.example.captions",
          payload: { text: event.text },
        });
      });

      // Set up the display waiter BEFORE injecting transcription
      const displayPromise = sim.display.waitFor({ timeout: 2000 });

      // Inject transcription (simulates cloud sending STT result)
      client.injectTranscription({
        text: "hello from the cloud",
        isFinal: true,
        language: "en",
      });

      // The display should have been updated
      const displayEvent = await displayPromise;
      expect(displayEvent.payload.text).toBe("hello from the cloud");

      // And the history should show it
      expect(sim.display.history).toHaveLength(1);

      // And the client's display manager should track it
      expect(client.display.mainEvent?.payload.text).toBe(
        "hello from the cloud",
      );
    });
  });
});
