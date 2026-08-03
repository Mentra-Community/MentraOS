import { describe, expect, test } from "bun:test";
import { CloudToGlassesMessageType } from "@mentra/sdk";
import { WebSocketReadyState } from "../../websocket/types";
import { PhotoManager } from "../PhotoManager";

function createMockLogger() {
  const noop = (..._args: unknown[]) => {};
  const child = () => createMockLogger();
  return { debug: noop, info: noop, warn: noop, error: noop, child } as any;
}

describe("PhotoManager requestPhoto", () => {
  test("forwards exposureTimeNs to glasses when valid", async () => {
    const sent: string[] = [];
    const mockSession = {
      sessionId: "sess-1",
      userId: "user-1",
      logger: createMockLogger(),
      websocket: {
        readyState: WebSocketReadyState.OPEN,
        send: (s: string) => sent.push(s),
      },
      deviceManager: {
        isGlassesConnected: true,
        getModel: () => "Simulated Glasses",
        getDeviceState: () => ({ timestamp: new Date() }),
      },
      installedApps: new Map([["com.app", { publicUrl: "https://app.example" }]]),
    };

    const pm = new PhotoManager(mockSession as any);
    await pm.requestPhoto({
      packageName: "com.app",
      requestId: "req-1",
      size: "medium",
      mode: "text",
      compress: "none",
      sound: true,
      exposureTimeNs: 5_000_000,
    });

    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0]!);
    expect(body.type).toBe(CloudToGlassesMessageType.PHOTO_REQUEST);
    expect(body.exposureTimeNs).toBe(5_000_000);
    expect(body.mode).toBe("text");
    expect(body.flash).toBe(true);
    expect(body.sound).toBe(true);
  });

  test("omits exposureTimeNs when not a valid positive number", async () => {
    const sent: string[] = [];
    const mockSession = {
      sessionId: "sess-2",
      userId: "user-2",
      logger: createMockLogger(),
      websocket: {
        readyState: WebSocketReadyState.OPEN,
        send: (s: string) => sent.push(s),
      },
      deviceManager: {
        isGlassesConnected: true,
        getModel: () => "Simulated Glasses",
        getDeviceState: () => ({ timestamp: new Date() }),
      },
      installedApps: new Map([["com.app", { publicUrl: "https://app.example" }]]),
    };

    const pm = new PhotoManager(mockSession as any);
    await pm.requestPhoto({
      packageName: "com.app",
      requestId: "req-2",
      size: "large",
      compress: "medium",
      sound: false,
    });

    const body = JSON.parse(sent[0]!);
    expect(body.type).toBe(CloudToGlassesMessageType.PHOTO_REQUEST);
    expect(body.mode).toBe("photo");
    expect(Object.prototype.hasOwnProperty.call(body, "exposureTimeNs")).toBe(false);
  });

  test("normalizes an invalid runtime mode to photo", async () => {
    const sent: string[] = [];
    const mockSession = {
      sessionId: "sess-3",
      userId: "user-3",
      logger: createMockLogger(),
      websocket: {
        readyState: WebSocketReadyState.OPEN,
        send: (s: string) => sent.push(s),
      },
      deviceManager: {
        isGlassesConnected: true,
        getModel: () => "Simulated Glasses",
        getDeviceState: () => ({ timestamp: new Date() }),
      },
      installedApps: new Map([["com.app", { publicUrl: "https://app.example" }]]),
    };

    const pm = new PhotoManager(mockSession as any);
    await pm.requestPhoto({
      packageName: "com.app",
      requestId: "req-3",
      mode: "unsupported",
    } as any);

    expect(JSON.parse(sent[0]!).mode).toBe("photo");
  });
});
