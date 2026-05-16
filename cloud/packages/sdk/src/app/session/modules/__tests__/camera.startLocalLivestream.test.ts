import { describe, it, expect, beforeEach } from "bun:test";
import { CameraModule } from "../camera";
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

function createSession() {
  const sent: unknown[] = [];
  const session = {
    sendMessage: (m: unknown) => {
      sent.push(m);
    },
    getHttpsServerUrl: () => "",
  };
  return { session, sent };
}

describe("CameraModule.startLocalLivestream", () => {
  let sent: unknown[];
  let cam: CameraModule;

  beforeEach(() => {
    const { session, sent: s } = createSession();
    sent = s;
    cam = new CameraModule(session, "com.test.app", "session-1", createLogger());
  });

  const validStream = { streamUrl: "rtmp://127.0.0.1/live/test" };

  it("throws RangeError for invalid video.width and does not sendMessage", async () => {
    await expect(
      cam.startLocalLivestream({
        ...validStream,
        video: { width: 100 },
      }),
    ).rejects.toThrow(RangeError);
    expect(sent.length).toBe(0);
  });

  it("sends STREAM_REQUEST for valid startLocalLivestream", async () => {
    await cam.startLocalLivestream(validStream);
    expect(sent.length).toBe(1);
    const msg = sent[0] as { type: string; streamUrl?: string };
    expect(msg.type).toBe(AppToCloudMessageType.STREAM_REQUEST);
    expect(msg.streamUrl).toBe(validStream.streamUrl);
  });

  it("validates video before the Already streaming guard", async () => {
    await cam.startLocalLivestream(validStream);
    expect(sent.length).toBe(1);

    await expect(
      cam.startLocalLivestream({
        ...validStream,
        video: { width: 100 },
      }),
    ).rejects.toThrow(RangeError);
    expect(sent.length).toBe(1);

    await expect(cam.startLocalLivestream({ streamUrl: "rtmp://other/live/x" })).rejects.toThrow("Already streaming");
    expect(sent.length).toBe(1);
  });
});
