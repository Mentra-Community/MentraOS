import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { systemTimers, type CloudClientTimers } from "../../timers";
import { Camera } from "./camera";

describe("Camera", () => {
  test("uses the injected scheduler for managed-photo timeouts", async () => {
    const timeoutHandle = { kind: "photo-timeout" };
    const cleared: unknown[] = [];
    const scheduledDelays: number[] = [];
    const timers: CloudClientTimers = {
      ...systemTimers,
      setTimeout(_callback, delayMs) {
        scheduledDelays.push(delayMs);
        return timeoutHandle;
      },
      clearTimeout(handle) {
        cleared.push(handle);
      },
    };
    const camera = new Camera({ http: {} as HttpClient, timers });

    const ready = camera.awaitPhotoReady("photo-1");
    camera.handlePush({
      v: 2,
      type: "photo.ready",
      timestamp: Date.now(),
      payload: { requestId: "photo-1", readUrl: "https://photos.test/photo-1" },
    });

    await expect(ready).resolves.toEqual({
      requestId: "photo-1",
      readUrl: "https://photos.test/photo-1",
    });
    expect(scheduledDelays).toEqual([30_000]);
    expect(cleared).toEqual([timeoutHandle]);
  });
});
