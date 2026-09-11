import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../types/hono.types";

const BEARER_PREFIX = "Bearer ";
const MIN_TOKEN_LENGTH = 32;

/** Authenticate the private agent without granting access to other admin APIs. */
export const reportAgentAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = process.env.CLOUD_REPORT_AGENT_API_TOKEN?.trim() ?? "";
  const header = c.req.header("authorization") ?? "";
  const actual = header.startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length).trim()
    : "";

  if (
    expected.length < MIN_TOKEN_LENGTH ||
    actual.length < MIN_TOKEN_LENGTH ||
    !safeEqual(actual, expected)
  ) {
    return c.json(
      { error: "unauthorized", error_description: "report agent credential required" },
      401,
      { "WWW-Authenticate": "Bearer" },
    );
  }

  return next();
});

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
