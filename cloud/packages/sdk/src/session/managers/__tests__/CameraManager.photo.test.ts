import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppToCloudMessageType } from "../../../types";
import { CameraManager, type CameraManagerDeps } from "../CameraManager";

describe("CameraManager takePhoto exposureTimeNs", () => {
  let lastOutbound: Record<string, unknown> | undefined;
  let manager: CameraManager;

  const noop = () => {};
  const createDeps = (): CameraManagerDeps => ({
    router: { on: () => () => {} },
    messageHandlers: { register: () => () => {} },
    addSubscription: noop,
    removeSubscription: noop,
    sendMessage: (message: unknown) => {
      lastOutbound = message as Record<string, unknown>;
    },
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    getPackageName: () => "com.test.app",
    getSessionId: () => "session-test",
  });

  beforeEach(() => {
    lastOutbound = undefined;
    manager = new CameraManager(createDeps());
  });

  afterEach(() => {
    manager.destroy();
  });

  test("includes exposureTimeNs when valid positive number", async () => {
    const p = manager.takePhoto({ exposureTimeNs: 33_333_333 });
    expect(lastOutbound?.type).toBe(AppToCloudMessageType.PHOTO_REQUEST);
    expect(lastOutbound?.exposureTimeNs).toBe(33_333_333);
    const rid = lastOutbound?.requestId as string;
    manager.handlePhotoResponse({
      requestId: rid,
      success: true,
      photoUrl: "https://x/u.jpg",
      width: 1,
      height: 1,
      timestamp: new Date(),
      savedToGallery: false,
    });
    await p;
  });

  test("omits exposureTimeNs when absent", async () => {
    const p = manager.takePhoto({});
    expect(lastOutbound?.type).toBe(AppToCloudMessageType.PHOTO_REQUEST);
    expect(Object.prototype.hasOwnProperty.call(lastOutbound ?? {}, "exposureTimeNs")).toBe(false);
    const rid = lastOutbound?.requestId as string;
    manager.handlePhotoResponse({
      requestId: rid,
      success: true,
      photoUrl: "https://x/u.jpg",
      width: 1,
      height: 1,
      timestamp: new Date(),
      savedToGallery: false,
    });
    await p;
  });
});
