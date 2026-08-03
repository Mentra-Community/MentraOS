import { describe, expect, test } from "bun:test";
import { AppToCloudMessageType } from "../../types";
import { _V2CameraShim } from "./_V2CameraShim";

function createShim() {
  const sent: Array<Record<string, unknown>> = [];
  let pending: any;
  const session = {
    userId: "user-1",
    sessionId: "session-1",
    packageName: "com.test.app",
    camera: { hasPermission: true },
    sendMessage: (message: Record<string, unknown>) => sent.push(message),
  };
  const bridge = {
    registerPhotoRequest: (_requestId: string, request: unknown) => {
      pending = request;
    },
    completePhotoRequest: () => {
      const result = pending;
      pending = undefined;
      return result;
    },
  };
  return { shim: new _V2CameraShim(session as any, { photoRequestBridge: bridge }), sent };
}

describe("_V2CameraShim requestPhoto", () => {
  test("forwards text mode", async () => {
    const { shim, sent } = createShim();

    await shim.requestPhoto({ mode: "text", customWebhookUrl: "https://upload.example/photo" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(AppToCloudMessageType.PHOTO_REQUEST);
    expect(sent[0]?.mode).toBe("text");
  });

  test("defaults mode to photo", async () => {
    const { shim, sent } = createShim();

    await shim.requestPhoto({ customWebhookUrl: "https://upload.example/photo" });

    expect(sent[0]?.mode).toBe("photo");
  });
});
