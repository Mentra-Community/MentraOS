import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.types";
import { reportAgentAuth } from "./report-agent-auth.middleware";

const TOKEN = "a".repeat(64);
let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.CLOUD_REPORT_AGENT_API_TOKEN;
  process.env.CLOUD_REPORT_AGENT_API_TOKEN = TOKEN;
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.CLOUD_REPORT_AGENT_API_TOKEN;
  else process.env.CLOUD_REPORT_AGENT_API_TOKEN = previousToken;
});

async function request(authorization?: string): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use("*", reportAgentAuth);
  app.get("/reports", c => c.json({ ok: true }));
  return app.request("http://localhost/reports", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("reportAgentAuth", () => {
  test("accepts the configured bearer credential", async () => {
    const response = await request(`Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
  });

  test("rejects missing and incorrect credentials", async () => {
    expect((await request()).status).toBe(401);
    expect((await request(`Bearer ${"b".repeat(64)}`)).status).toBe(401);
  });

  test("fails closed when the service credential is not configured", async () => {
    delete process.env.CLOUD_REPORT_AGENT_API_TOKEN;
    expect((await request(`Bearer ${TOKEN}`)).status).toBe(401);
  });
});
