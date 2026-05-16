import { describe, it, expect, beforeEach } from "bun:test";
import { CameraManagedExtension } from "../camera-managed-extension";
import { AppToCloudMessageType } from "../../../../types/message-types";

function createLogger() {
  const child = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  };
  return {
    child: () => child,
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  } as any;
}

describe("CameraManagedExtension.startManagedStream", () => {
  let sent: unknown[];
  let ext: CameraManagedExtension;

  beforeEach(() => {
    const s: unknown[] = [];
    sent = s;
    const session = {
      sendMessage: (m: unknown) => {
        s.push(m);
      },
    };
    ext = new CameraManagedExtension(session, "com.test.app", "session-1", createLogger());
  });

  it("throws RangeError for invalid video.width and does not sendMessage", async () => {
    await expect(ext.startManagedStream({ video: { width: 100 } })).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });

  it("sends MANAGED_STREAM_REQUEST for valid startManagedStream", async () => {
    const p = ext.startManagedStream({ video: { width: 1280, height: 720 } });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(sent.length).toBe(1);
    const msg = sent[0] as { type: string };
    expect(msg.type).toBe(AppToCloudMessageType.MANAGED_STREAM_REQUEST);
    (ext as any)["pendingManagedStreamRequest"]?.reject(new Error("cleanup"));
    await expect(p).rejects.toThrow("cleanup");
  });

  it("validates video before the Already streaming guard", async () => {
    const inflight = ext.startManagedStream({ video: { width: 1280, height: 720 } });
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(sent.length).toBe(1);

    await expect(ext.startManagedStream({ video: { width: 100 } })).rejects.toThrow(RangeError);
    expect(sent.length).toBe(1);

    await expect(ext.startManagedStream({ video: { width: 1280, height: 720 } })).rejects.toThrow("Already streaming");

    (ext as any)["pendingManagedStreamRequest"]?.reject(new Error("cleanup"));
    await expect(inflight).rejects.toThrow("cleanup");
  });
});
