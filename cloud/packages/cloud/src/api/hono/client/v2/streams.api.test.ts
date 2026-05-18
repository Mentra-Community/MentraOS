/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test";
import jwt from "jsonwebtoken";

// Auth secret must be set BEFORE the client.middleware module is loaded — it
// reads process.env at the top level and throws if undefined. If a prior test
// in the same bun:test process imported the middleware with a DIFFERENT
// secret, our jwt.sign() calls would be verified against that one and 401.
// In practice the value is constant across this codebase, so this is fine.
process.env.AUGMENTOS_AUTH_JWT_SECRET = "test-secret";

// Stub the Cloudflare service to keep tests offline + deterministic.
const createLiveInput = mock(async (_userId: string, _config: unknown) => ({
  liveInputId: "cf-input-abc",
  rtmpUrl: "rtmp://ingest.example/abc",
  srtUrl: "srt://ingest.example/abc",
  hlsUrl: "https://cf.example/abc/manifest/video.m3u8",
  dashUrl: "https://cf.example/abc/manifest/video.mpd",
  webrtcUrl: "https://cf.example/abc/whep",
  webrtcPublishUrl: "https://cf.example/abc/whip",
  outputs: [],
}));

const getLiveInputStatus = mock(async (_id: string) => ({
  isConnected: true,
  connectedAt: new Date(),
  viewerCount: 0,
}));

const deleteLiveInput = mock(async (_id: string) => undefined);

mock.module(
  "../../../../services/streaming/CloudflareStreamService",
  () => ({
    CloudflareStreamService: class {
      createLiveInput = createLiveInput;
      getLiveInputStatus = getLiveInputStatus;
      deleteLiveInput = deleteLiveInput;
    },
  }),
);

const stubLogger: any = {
  error: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  child: () => stubLogger,
};

mock.module("../../../../services/logging/pino-logger", () => ({
  logger: stubLogger,
  default: stubLogger,
}));

mock.module("../../../../services/logging", () => ({
  logger: stubLogger,
  default: stubLogger,
}));

const { default: app } = await import("./streams.api");

function authHeader(email = "alex@example.com"): Record<string, string> {
  const token = jwt.sign({ email }, "test-secret");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

describe("v2 streams API", () => {
  beforeEach(() => {
    createLiveInput.mockClear();
    getLiveInputStatus.mockClear();
    deleteLiveInput.mockClear();
  });

  describe("POST /provision", () => {
    test("rejects requests without a bearer token", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    test("provisions a live input with no destinations", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { liveInputId: string };
      expect(body.liveInputId).toBe("cf-input-abc");
      expect(createLiveInput).toHaveBeenCalledTimes(1);
    });

    test("provisions a live input when the body is empty", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      expect(createLiveInput).toHaveBeenCalledTimes(1);
    });

    test("rejects malformed JSON bodies with 400 instead of provisioning", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: "{not-json",
      });
      expect(res.status).toBe(400);
      expect(createLiveInput).not.toHaveBeenCalled();
    });

    test("rejects non-object JSON bodies with 400", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: "[]",
      });
      expect(res.status).toBe(400);
      expect(createLiveInput).not.toHaveBeenCalled();
    });

    test("forwards object-shape restream destinations to the Cloudflare service", async () => {
      const destinations = [{ url: "rtmp://yt", name: "YouTube" }];
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ restreamDestinations: destinations }),
      });
      expect(res.status).toBe(200);
      const callArgs = createLiveInput.mock.calls[0]!;
      expect((callArgs[1] as { restreamDestinations?: unknown }).restreamDestinations).toEqual(
        destinations,
      );
    });

    test("normalizes plain-string URL destinations to {url} objects", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ restreamDestinations: ["rtmp://yt/STREAM-KEY"] }),
      });
      expect(res.status).toBe(200);
      const callArgs = createLiveInput.mock.calls[0]!;
      expect((callArgs[1] as { restreamDestinations?: unknown }).restreamDestinations).toEqual([
        { url: "rtmp://yt/STREAM-KEY" },
      ]);
    });

    test("rejects malformed restream destinations with 400", async () => {
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({ restreamDestinations: [{ wrong: "shape" }] }),
      });
      expect(res.status).toBe(400);
      expect(createLiveInput).not.toHaveBeenCalled();
    });

    test("passes Cloudflare errors through as 502", async () => {
      createLiveInput.mockRejectedValueOnce(new Error("cf is down"));
      const res = await app.request("http://x/provision", {
        method: "POST",
        headers: authHeader(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { success: false; code: string; message: string };
      expect(body.success).toBe(false);
      expect(body.code).toBe("provision_failed");
      expect(body.message).toContain("cf is down");
    });
  });

  // Status/teardown tests provision first so the owner map knows about the
  // liveInputId. Without provisioning, a "not_found" 404 is the correct
  // response and is verified separately below.
  async function provision(email = "alex@example.com") {
    await app.request("http://x/provision", {
      method: "POST",
      headers: authHeader(email),
      body: JSON.stringify({}),
    });
  }

  describe("GET /:liveInputId/status", () => {
    test("returns the Cloudflare status for the owner", async () => {
      await provision();
      const res = await app.request("http://x/cf-input-abc/status", {
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { isConnected: boolean };
      expect(body.isConnected).toBe(true);
      expect(getLiveInputStatus).toHaveBeenCalledWith("cf-input-abc");
    });

    test("returns 404 when the caller is not the owner", async () => {
      await provision("alex@example.com");
      const res = await app.request("http://x/cf-input-abc/status", {
        headers: authHeader("eve@evil.com"),
      });
      expect(res.status).toBe(404);
      expect(getLiveInputStatus).not.toHaveBeenCalled();
    });

    test("returns 404 for unknown liveInputId (even with valid auth)", async () => {
      const res = await app.request("http://x/never-provisioned/status", {
        headers: authHeader(),
      });
      expect(res.status).toBe(404);
    });

    test("returns 502 when Cloudflare errors for owned input", async () => {
      await provision();
      getLiveInputStatus.mockRejectedValueOnce(new Error("timeout"));
      const res = await app.request("http://x/cf-input-abc/status", {
        headers: authHeader(),
      });
      expect(res.status).toBe(502);
    });
  });

  describe("DELETE /:liveInputId", () => {
    test("tears down the live input for the owner", async () => {
      await provision();
      const res = await app.request("http://x/cf-input-abc", {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(deleteLiveInput).toHaveBeenCalledWith("cf-input-abc");
    });

    test("returns 404 when caller is not the owner", async () => {
      await provision("alex@example.com");
      const res = await app.request("http://x/cf-input-abc", {
        method: "DELETE",
        headers: authHeader("eve@evil.com"),
      });
      expect(res.status).toBe(404);
      expect(deleteLiveInput).not.toHaveBeenCalled();
    });

    test("returns 502 on Cloudflare error (not swallowed by service)", async () => {
      await provision();
      deleteLiveInput.mockRejectedValueOnce(new Error("cf 500"));
      const res = await app.request("http://x/cf-input-abc", {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(502);
    });
  });
});
