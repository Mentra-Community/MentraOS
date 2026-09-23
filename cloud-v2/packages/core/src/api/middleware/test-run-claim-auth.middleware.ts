import { createHash, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../types/hono.types";

/** Fleet claim capability, separate from result ingestion and admin sessions. */
export const testRunClaimAuth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = process.env.TEST_RUN_CLAIM_TOKEN;
  if (!expected || expected.length < 32) {
    return c.json({ error: "unavailable", error_description: "test run claims are not configured" }, 503);
  }
  const provided = /^Bearer (\S{1,4096})$/.exec(c.req.header("authorization") ?? "")?.[1];
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    return c.json({ error: "unauthorized", error_description: "test run claim token required" }, 401);
  }
  return next();
});
