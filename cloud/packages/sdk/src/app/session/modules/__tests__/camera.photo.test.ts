import { describe, expect, test } from "bun:test";
import { AppToCloudMessageType } from "../../../../types/message-types";
import { CameraModule } from "../camera";

function createLogger() {
  const noop = () => {};
  const logger = { info: noop, debug: noop, error: noop, warn: noop } as any;
  logger.child = () => logger;
  return logger;
}

function createCamera() {
  const sent: Array<Record<string, unknown>> = [];
  let pending: any;
  const session = {
    userId: "user-1",
    getHttpsServerUrl: () => "",
    sendMessage: (message: Record<string, unknown>) => sent.push(message),
    appServer: {
      registerPhotoRequest: (_requestId: string, request: unknown) => {
        pending = request;
      },
      completePhotoRequest: () => {
        const result = pending;
        pending = undefined;
        return result;
      },
    },
  };
  return {
    camera: new CameraModule(session, "com.test.app", "session-1", createLogger()),
    sent,
  };
}

describe("CameraModule requestPhoto", () => {
  test("forwards text mode", async () => {
    const { camera, sent } = createCamera();

    await camera.requestPhoto({ mode: "text", customWebhookUrl: "https://upload.example/photo" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(AppToCloudMessageType.PHOTO_REQUEST);
    expect(sent[0]?.mode).toBe("text");
  });

  test("defaults mode to photo", async () => {
    const { camera, sent } = createCamera();

    await camera.requestPhoto({ customWebhookUrl: "https://upload.example/photo" });

    expect(sent[0]?.mode).toBe("photo");
  });
});
