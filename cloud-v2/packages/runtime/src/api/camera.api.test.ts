import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";

import * as shared from "@mentra/cloud-shared";
import * as camera from "../services/camera/camera.service";
import { cameraApi, publicOrigin } from "./camera.api";

async function originFor(url: string, headers: Record<string, string> = {}): Promise<string> {
  const app = new Hono();
  app.get("/probe", (c) => c.text(publicOrigin(c)));
  const response = await app.request(url, { headers });
  return response.text();
}

describe("camera publicOrigin", () => {
  test("derives HTTPS from the TLS-terminating ingress", async () => {
    expect(
      await originFor("http://runtime.dev.us-west-2.mentraglass.com/probe", {
        "x-forwarded-proto": "https",
      }),
    ).toBe("https://runtime.dev.us-west-2.mentraglass.com");
  });

  test("uses the first protocol when multiple trusted proxies append values", async () => {
    expect(
      await originFor("http://runtime.internal/probe", {
        "x-forwarded-proto": "https, http",
      }),
    ).toBe("https://runtime.internal");
  });

  test("falls back to the request protocol for direct local requests", async () => {
    expect(await originFor("http://localhost:3001/probe")).toBe("http://localhost:3001");
    expect(await originFor("https://runtime.example.com/probe")).toBe(
      "https://runtime.example.com",
    );
  });

  test("ignores unsupported forwarded protocols", async () => {
    expect(
      await originFor("http://runtime.example.com/probe", {
        "x-forwarded-proto": "javascript",
      }),
    ).toBe("http://runtime.example.com");
  });
});

describe("photo URL allocation", () => {
  const result = { requestId: "photo-1", uploadUrl: "https://upload", readUrl: "https://read" };
  let verify: ReturnType<typeof spyOn<typeof shared, "verifyRuntimeToken">>;
  let allocate: ReturnType<typeof spyOn<typeof camera, "requestPhoto">>;

  beforeEach(() => {
    verify = spyOn(shared, "verifyRuntimeToken").mockResolvedValue({
      mentraUserId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      jti: "token-1",
      exp: 9999999999,
    });
    allocate = spyOn(camera, "requestPhoto").mockResolvedValue(result);
  });

  afterEach(() => {
    verify.mockRestore();
    allocate.mockRestore();
  });

  test.each([
    undefined,
    JSON.stringify({ size: "medium" }),
    JSON.stringify({ size: "medium", compress: "heavy", sound: false, saveToGallery: true }),
    JSON.stringify({ size: "unknown", compress: null }),
    "not JSON",
  ])("allocates URLs regardless of unused body %p", async (body) => {
    const response = await cameraApi.request("http://runtime.test/photo", {
      method: "POST",
      headers: { Authorization: "Bearer token", "x-forwarded-proto": "https" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(verify).toHaveBeenCalledWith("token");
    expect(allocate.mock.calls).toEqual([["user-1", "https://runtime.test"]]);
  });

  test("still requires authentication before allocating URLs", async () => {
    const response = await cameraApi.request("/photo", { method: "POST" });
    expect(response.status).toBe(401);
    expect(allocate).not.toHaveBeenCalled();
  });

  test("rejects an invalid token before allocating URLs", async () => {
    verify.mockRejectedValueOnce(new shared.AccessTokenError("invalid token"));
    const response = await cameraApi.request("/photo", {
      method: "POST",
      headers: { Authorization: "Bearer invalid" },
    });
    expect(response.status).toBe(401);
    expect(allocate).not.toHaveBeenCalled();
  });
});
