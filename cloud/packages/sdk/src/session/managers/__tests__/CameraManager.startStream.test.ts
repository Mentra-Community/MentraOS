import { describe, it, expect, beforeEach } from "bun:test";
import { CameraManager, type CameraManagerDeps } from "../CameraManager";
import { AppToCloudMessageType } from "../../../types/message-types";

function createDeps(): { deps: CameraManagerDeps; sent: unknown[] } {
  const sent: unknown[] = [];
  const deps: CameraManagerDeps = {
    router: { on: () => () => {} },
    messageHandlers: { register: () => () => {} },
    addSubscription: () => {},
    removeSubscription: () => {},
    sendMessage: (m: unknown) => {
      sent.push(m);
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    getPackageName: () => "com.test.app",
    getSessionId: () => "session-1",
  };
  return { deps, sent };
}

describe("CameraManager.startStream", () => {
  let sent: unknown[];
  let deps: CameraManagerDeps;
  let mgr: CameraManager;

  beforeEach(() => {
    const d = createDeps();
    sent = d.sent;
    deps = d.deps;
    mgr = new CameraManager(deps);
  });

  it("throws RangeError for invalid video.width and does not sendMessage", async () => {
    await expect(mgr.startStream({ video: { width: 100 } })).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });

  it("throws RangeError for direct stream with invalid frameRate and does not sendMessage", async () => {
    await expect(
      mgr.startStream({
        direct: "srt://127.0.0.1:4201?mode=caller",
        video: { frameRate: 9 },
      }),
    ).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });

  it("sends MANAGED_STREAM_REQUEST for valid managed startStream", async () => {
    const p = mgr.startStream({ video: { width: 1280, height: 720 } });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(sent.length).toBe(1);
    const msg = sent[0] as { type: string; video?: { width?: number } };
    expect(msg.type).toBe(AppToCloudMessageType.MANAGED_STREAM_REQUEST);
    expect(msg.video?.width).toBe(1280);
    // avoid hanging on pending promise
    mgr["pendingManagedStreamRequest"]?.reject(new Error("cleanup"));
    await expect(p).rejects.toThrow("cleanup");
  });

  it("validates video before the Already streaming guard (managed)", async () => {
    const inflight = mgr.startStream({ video: { width: 1280, height: 720 } });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(sent.length).toBe(1);

    await expect(mgr.startStream({ video: { width: 100 } })).rejects.toThrow(RangeError);
    expect(sent.length).toBe(1);
    await expect(mgr.startStream({ video: { width: 1280, height: 720 } })).rejects.toThrow(
      "Already streaming",
    );

    mgr["pendingManagedStreamRequest"]?.reject(new Error("cleanup"));
    await expect(inflight).rejects.toThrow("cleanup");
  });
});

describe("CameraManager deprecated stream entry points", () => {
  let sent: unknown[];
  let mgr: CameraManager;

  beforeEach(() => {
    const d = createDeps();
    sent = d.sent;
    mgr = new CameraManager(d.deps);
  });

  it("startDirectStream validates video before sendMessage", async () => {
    await expect(
      mgr.startDirectStream({
        rtmpUrl: "rtmp://127.0.0.1/live/x",
        video: { width: 100 },
      }),
    ).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });

  it("startManagedStream validates video before sendMessage", async () => {
    await expect(mgr.startManagedStream({ video: { width: 100 } })).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });
});
