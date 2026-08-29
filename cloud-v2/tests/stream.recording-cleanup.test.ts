/**
 * @fileoverview Recording cleanup on the Cloudflare Stream provider.
 *
 * Fixtures intentionally match Cloudflare's documented REST shapes. The live
 * input list wraps entries in `result.liveInputs`, while connection status is
 * available only from the per-input GET.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCloudflareStreamProvider } from "../packages/runtime/src/services/stream/providers/cloudflare-stream.provider";

const ACCT = "acct123";
const LIVE_INPUTS_PATH = `/client/v4/accounts/${ACCT}/stream/live_inputs`;
const realFetch = globalThis.fetch;

let calls: string[] = [];

interface Video {
  uid: string;
  status?: { state?: string };
}

interface InputSummary {
  uid: string;
  created?: string;
  modified?: string;
  meta?: { name?: string };
}

interface InputDetail {
  uid: string;
  status?:
    | string
    | {
        current?: {
          state?: string | null;
          statusEnteredAt?: string;
          statusLastSeen?: string;
          reason?: string;
        } | null;
      }
    | null;
}

interface Routes {
  videos?: Record<string, Video[]>;
  inputs?: InputSummary[];
  details?: Record<string, InputDetail>;
  videoListStatus?: Record<string, number>;
  videoDeleteStatus?: Record<string, number>;
  listWindowSize?: number;
}

function stubFetch(routes: Routes) {
  const deletedInputs = new Set<string>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);

    if (method === "GET" && path === LIVE_INPUTS_PATH) {
      const remaining = (routes.inputs ?? []).filter((candidate) => !deletedInputs.has(candidate.uid));
      const liveInputs = remaining.slice(0, routes.listWindowSize ?? remaining.length);
      return new Response(
        JSON.stringify({
          success: true,
          result: { liveInputs, range: liveInputs.length, total: remaining.length },
        }),
      );
    }

    const videosMatch = path.match(/\/live_inputs\/([^/]+)\/videos$/);
    if (method === "GET" && videosMatch) {
      const inputUid = videosMatch[1]!;
      const status = routes.videoListStatus?.[inputUid];
      if (status) return new Response("upstream failure", { status });
      return new Response(
        JSON.stringify({ success: true, result: routes.videos?.[inputUid] ?? [] }),
      );
    }

    const inputMatch = path.match(/\/live_inputs\/([^/]+)$/);
    if (method === "GET" && inputMatch) {
      const inputUid = inputMatch[1]!;
      return new Response(
        JSON.stringify({
          success: true,
          result: routes.details?.[inputUid] ?? { uid: inputUid, status: "client_disconnect" },
        }),
      );
    }
    if (method === "DELETE" && inputMatch) {
      deletedInputs.add(inputMatch[1]!);
    }

    const videoMatch = path.match(/\/stream\/([^/]+)$/);
    if (method === "DELETE" && videoMatch) {
      const status = routes.videoDeleteStatus?.[videoMatch[1]!];
      if (status) return new Response("upstream failure", { status });
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
  test("stop disables the input, deletes ready recordings, then deletes the input", async () => {
    stubFetch({ videos: { input1: [{ uid: "vid1", status: { state: "ready" } }] } });

    await createCloudflareStreamProvider().stop("input1");

    const disable = calls.indexOf(`PUT ${LIVE_INPUTS_PATH}/input1`);
    const recording = calls.indexOf(`DELETE /client/v4/accounts/${ACCT}/stream/vid1`);
    const input = calls.indexOf(`DELETE ${LIVE_INPUTS_PATH}/input1`);
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(recording).toBeGreaterThan(disable);
    expect(input).toBeGreaterThan(recording);
  });

  test("stop retains the input while its recording is still finalizing", async () => {
    stubFetch({
      videos: { input1: [{ uid: "live1", status: { state: "live-inprogress" } }] },
    });

    await createCloudflareStreamProvider().stop("input1");

    expect(calls).toContain(`PUT ${LIVE_INPUTS_PATH}/input1`);
    expect(calls).not.toContain(`DELETE /client/v4/accounts/${ACCT}/stream/live1`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/input1`);
  });

  test("stop retains the input when no recording is visible yet", async () => {
    stubFetch({ videos: { input1: [] } });

    await createCloudflareStreamProvider().stop("input1");

    expect(calls).toContain(`PUT ${LIVE_INPUTS_PATH}/input1`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/input1`);
  });

  test("stop fails closed when recording enumeration fails", async () => {
    stubFetch({ videoListStatus: { input1: 503 } });

    await expect(createCloudflareStreamProvider().stop("input1")).rejects.toThrow(
      "cloudflare recording list failed: 503",
    );

    expect(calls).toContain(`PUT ${LIVE_INPUTS_PATH}/input1`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/input1`);
  });

  test("queue recovery verifies status and reclaims a disconnected input", async () => {
    stubFetch({
      details: { stale: { uid: "stale", status: "client_disconnect" } },
      videos: { stale: [{ uid: "done1", status: { state: "ready" } }] },
    });

    const result = await createCloudflareStreamProvider().reclaim!("stale");

    expect(result).toEqual({ recordings: 1, input: "deleted" });
    expect(calls).toContain(`GET ${LIVE_INPUTS_PATH}/stale`);
    expect(calls).toContain(`PUT ${LIVE_INPUTS_PATH}/stale`);
    expect(calls).toContain(`DELETE ${LIVE_INPUTS_PATH}/stale`);
  });

  test("queue recovery never disables or deletes an active input", async () => {
    stubFetch({
      details: { busy: { uid: "busy", status: "connected" } },
    });

    const result = await createCloudflareStreamProvider().reclaim!("busy");

    expect(result).toEqual({ recordings: 0, input: "retained" });
    expect(calls).toContain(`GET ${LIVE_INPUTS_PATH}/busy`);
    expect(calls).not.toContain(`PUT ${LIVE_INPUTS_PATH}/busy`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/busy`);
  });

  test("queue recovery protects a reconnecting input without reporting it connected", async () => {
    stubFetch({
      details: { busy: { uid: "busy", status: "reconnecting" } },
    });

    const provider = createCloudflareStreamProvider();
    const cleanup = await provider.reclaim!("busy");
    const status = await provider.status("busy");

    expect(cleanup).toEqual({ recordings: 0, input: "retained" });
    expect(status).toMatchObject({
      streamId: "busy",
      isConnected: false,
      state: "reconnecting",
    });
    expect(calls).not.toContain(`PUT ${LIVE_INPUTS_PATH}/busy`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/busy`);
  });

  test("legacy discovery parses the documented list shape and ignores foreign inputs", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    stubFetch({
      inputs: [
        { uid: "owned", created: old, meta: { name: "mentra-user1" } },
        { uid: "foreign", created: old, meta: { name: "other-service" } },
      ],
      listWindowSize: 1,
    });

    const result = await createCloudflareStreamProvider().discover!();

    expect(result).toEqual({
      inputs: [{ streamId: "owned", createdAt: Date.parse(old) }],
      truncated: true,
    });
    expect(calls).not.toContain(`GET ${LIVE_INPUTS_PATH}/foreign`);
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/foreign`);
  });

  test("queue recovery surfaces recording deletion failures and retains the input", async () => {
    stubFetch({
      videos: { stale: [{ uid: "failed-video", status: { state: "ready" } }] },
      videoDeleteStatus: { "failed-video": 503 },
    });

    await expect(createCloudflareStreamProvider().reclaim!("stale")).rejects.toThrow(
      "cloudflare recording cleanup failed for 1 recording(s)",
    );
    expect(calls).not.toContain(`DELETE ${LIVE_INPUTS_PATH}/stale`);
  });

  test("queue recovery deletes an empty input after the grace period", async () => {
    stubFetch({ videos: { stale: [] } });

    const result = await createCloudflareStreamProvider().reclaim!("stale");

    expect(result).toEqual({ recordings: 0, input: "deleted" });
    expect(calls).toContain(`DELETE ${LIVE_INPUTS_PATH}/stale`);
  });

  test("status accepts Cloudflare's root string status", async () => {
    stubFetch({ details: { input1: { uid: "input1", status: "reconnected" } } });

    const result = await createCloudflareStreamProvider().status("input1");

    expect(result).toMatchObject({ streamId: "input1", isConnected: true, state: "reconnected" });
  });

  test("provision sets a retention floor for recordings it cannot delete itself", async () => {
    let sentBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true, result: { uid: "u1" } }));
    }) as typeof fetch;

    await createCloudflareStreamProvider().provision("user1", {});

    expect(JSON.parse(sentBody).deleteRecordingAfterDays).toBe(30);
    expect(JSON.parse(sentBody).recording.mode).toBe("automatic");
    expect(JSON.parse(sentBody).meta.name).toBe("mentra-user1");
  });
});
