import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.types";
import { publicOrigin } from "./oauth.api";

async function originFor(url: string, headers: Record<string, string> = {}): Promise<string> {
  const app = new Hono<AppEnv>();
  app.get("/probe", (c) => c.text(publicOrigin(c)));
  const res = await app.request(url, { headers });
  return res.text();
}

describe("publicOrigin", () => {
  test("derives https from x-forwarded-proto behind the TLS-terminating ingress", async () => {
    expect(
      await originFor("http://core.dev.us-west-2.mentraglass.com/probe", {
        "x-forwarded-proto": "https",
      }),
    ).toBe("https://core.dev.us-west-2.mentraglass.com");
  });

  test("falls back to the request protocol when x-forwarded-proto is absent", async () => {
    expect(await originFor("http://localhost:8002/probe")).toBe("http://localhost:8002");
  });

  test("prefers x-mentra-public-origin over the derived origin", async () => {
    expect(
      await originFor("http://core.internal/probe", {
        "x-mentra-public-origin": "https://api.mentra.glass",
        "x-forwarded-proto": "https",
      }),
    ).toBe("https://api.mentra.glass");
  });
});
