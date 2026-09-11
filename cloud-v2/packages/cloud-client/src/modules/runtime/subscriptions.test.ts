import { describe, expect, test } from "bun:test";

import type { HttpClient } from "../../http";
import { systemTimers, type CloudClientTimers } from "../../timers";
import { Subscriptions } from "./subscriptions";

describe("Subscriptions", () => {
  test("uses the injected scheduler for stale-session retries", async () => {
    const scheduledDelays: number[] = [];
    const timers: CloudClientTimers = {
      ...systemTimers,
      setTimeout(callback, delayMs) {
        scheduledDelays.push(delayMs);
        callback();
        return { kind: "subscription-retry" };
      },
    };
    let calls = 0;
    const http = {
      async put() {
        calls += 1;
        return calls === 1
          ? { applied: false, version: 1, reason: "stale-session" }
          : { applied: true, version: 1, reason: null };
      },
    } as unknown as HttpClient;
    const subscriptions = new Subscriptions({ http, timers });

    await subscriptions.set([{ kind: "transcription", language: { mode: "auto" } }], "session-1");

    expect(calls).toBe(2);
    expect(scheduledDelays).toEqual([5_000]);
  });
});
