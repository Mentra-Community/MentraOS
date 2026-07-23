import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { publicOrigin } from "./camera.api";

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
