import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import reports from "./reports.api";

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

describe("report agent routes", () => {
  test("provides an authenticated health probe without exposing report enumeration", async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await reports.request("/health", { headers })).status).toBe(200);
    expect((await reports.request("/", { headers })).status).toBe(404);
  });
});
