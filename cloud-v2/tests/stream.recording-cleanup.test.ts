/**
 * @fileoverview Recording cleanup on the Cloudflare Stream provider (stubbed fetch).
 *
 * The account filled up because recordings outlive the live input that made
 * them: deleting an input orphans its recordings, which keep counting against
 * the storage quota until Cloudflare starts rejecting broadcasts at publish.
 * Recording cannot be turned off (HLS playback needs `mode: automatic`), so the
 * provider has to delete recordings itself.
 *
 * These assert the parts that are easy to get subtly wrong -- ordering, and
 * which things must never be deleted -- against a stubbed API rather than a
 * real account, so they run everywhere and cost nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCloudflareStreamProvider } from "../packages/runtime/src/services/stream/providers/cloudflare-stream.provider";

const ACCT = "acct123";
const realFetch = globalThis.fetch;

/** Requests the stub saw, in order, as "METHOD /path". */
let calls: string[] = [];

interface Route {
  videos?: Array<{ uid: string; status?: { state?: string } }>;
  inputs?: Array<{
    uid: string;
    modified?: string;
    status?: { current?: { state?: string | null } | null } | null;
  }>;
}

function stubFetch(routes: Route) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push(`${method} ${new URL(url).pathname}`);

    if (method === "GET" && url.endsWith("/videos")) {
      return new Response(JSON.stringify({ success: true, result: routes.videos ?? [] }));
    }
    if (method === "GET" && url.endsWith("/live_inputs")) {
      return new Response(JSON.stringify({ success: true, result: routes.inputs ?? [] }));
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.CF_STREAM_ACCOUNT_ID = ACCT;
  process.env.CF_STREAM_API_TOKEN = "token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("recording cleanup", () => {
  test("stop() deletes recordings before deleting the input", async () => {
    stubFetch({ videos: [{ uid: "vid1", status: { state: "ready" } }] });

    await createCloudflareStreamProvider().stop("input1");

    const recording = calls.indexOf(`DELETE /client/v4/accounts/${ACCT}/stream/vid1`);
    const input = calls.indexOf(`DELETE /client/v4/accounts/${ACCT}/stream/live_inputs/input1`);

    expect(recording).toBeGreaterThanOrEqual(0);
    expect(input).toBeGreaterThanOrEqual(0);
    // Order is the whole point: once the input is gone its recordings are no
    // longer reachable through /videos, so deleting it first strands them.
    expect(recording).toBeLessThan(input);
  });

  test("a broadcast still in progress is never deleted", async () => {
    stubFetch({
      videos: [
        { uid: "live1", status: { state: "live-inprogress" } },
        { uid: "done1", status: { state: "ready" } },
      ],
    });

    const deleted = await createCloudflareStreamProvider().deleteRecordings!("input1");

    expect(deleted).toBe(1);
    expect(calls).toContain(`DELETE /client/v4/accounts/${ACCT}/stream/done1`);
    expect(calls).not.toContain(`DELETE /client/v4/accounts/${ACCT}/stream/live1`);
  });

  test("sweep skips inputs that are too recent or still connected", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    stubFetch({
      inputs: [
        { uid: "stale", modified: old },
        { uid: "fresh", modified: recent },
        { uid: "busy", modified: old, status: { current: { state: "connected" } } },
      ],
      videos: [],
    });

    const { inputs } = await createCloudflareStreamProvider().sweep!(6 * 60 * 60 * 1000);

    expect(inputs).toBe(1);
    expect(calls).toContain(`DELETE /client/v4/accounts/${ACCT}/stream/live_inputs/stale`);
    // A live session must survive the sweep, and so must anything recent.
    expect(calls).not.toContain(`DELETE /client/v4/accounts/${ACCT}/stream/live_inputs/busy`);
    expect(calls).not.toContain(`DELETE /client/v4/accounts/${ACCT}/stream/live_inputs/fresh`);
  });

  test("provision sets a retention floor for recordings it cannot delete itself", async () => {
    let sentBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true, result: { uid: "u1" } }));
    }) as typeof fetch;

    await createCloudflareStreamProvider().provision("user1", {});

    expect(JSON.parse(sentBody).deleteRecordingAfterDays).toBe(30);
    // Recording must stay on: HLS playback does not work without it.
    expect(JSON.parse(sentBody).recording.mode).toBe("automatic");
  });
});
